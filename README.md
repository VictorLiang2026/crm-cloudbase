# 个人 CRM（CloudBase 个人版 · 事件云函数）

个人 CRM 系统，架构：**CloudBase 个人版 + 事件云函数 + 共享集群 PostgreSQL**。

- AI 仅用 **hy3**，通过 `app.ai().createModel('cloudbase')` 调用
- 禁止 deepseek / openai / 任何第三方 Key，禁止前端直连 AI
- 数据访问走 `@cloudbase/node-sdk@^4` 的 `app.rdb()`（云函数内免密，**无 PG_* 凭证**），环境变量仅需 `TCB_ENV` / `AI_MODEL=hy3`
- 不启用 VPC，不填 VPC ID / 子网
- 照片 base64 存 `photos` 表（不调多模态，不开云存储匿名登录）
- `admin.html` 通过 `callFunction`（同域）调云函数，不直连 PG，不直连 AI
- 数据库安全：6 张业务表启用 RLS，policy 仅放行云函数 token（详见「数据库安全（RLS）」）

## 目录结构

```
crm-cloudbase/
├── cloudfunctions/
│   ├── _shared/db.js                # 共享：rdb() 数据访问 + AI(hy3) 封装（部署时复制为各函数 ./db.js）
│   ├── customers/                   # 客户 CRUD
│   ├── followups/                   # 跟进记录 CRUD
│   ├── products/                    # 保单额度 upsert（每客户一行，11 个 ap_* + items JSON）
│   ├── gifts/                       # 伴手礼 CRUD
│   ├── photos/                      # 照片存储（base64 → photos 表）
│   ├── ai_recommendations/          # AI 建议历史列表（只读）
│   ├── ai_parse/                    # AI 文本解析 → 客户资料（hy3，120s）
│   ├── ai_recommend/                # AI 跟进建议生成（hy3，120s）
│   ├── policy_review_reports/       # 保单检视报告 5 段 AI 生成（120s）
│   ├── ocr_records/                 # OCR 识别记录（带 customer_snapshot）
│   ├── activity_reports/            # 活动量日报（客户 + 增员双轨聚合）
│   ├── recruit_candidates/          # 增员候选人 CRUD + funnel + soft delete
│   ├── recruit_followups/           # 增员跟进记录 CRUD
│   ├── recruit_goals/               # 月度目标 + getProgress（与行业基准对照）
│   ├── recruit_score/               # AI 高潜评分（hy3，120s，6 维度加权）
│   └── recruit_recommend/           # AI 接触建议（hy3，120s，STAR 异议框架）
├── admin.html                       # 单页管理台（callFunction 同域，单文件 4109 行）
├── cloudbase/migrations/            # 17 个迁移 SQL（含 RLS / 软删除 / 增员模块）
├── docs/                            # 架构图 + 优化方案
│   ├── architecture-current.md      # 单页式架构图（v2.0）
│   └── 对话历史记录.md              # 项目对话历史
├── backups/                         # 数据快照 + 恢复说明
├── SPEC-v1.md                       # 早期规格（6 表 8 函数 + PGHOST，已归档）
├── SPEC-v2.md                       # 当前规格（13 表 16 函数 + rdb()，2026-09-06 重写）
├── 增员平台开发方案.md              # 增员模块原始方案
├── 数据库信息.txt                   # 数据库连接信息
└── README.md                        # 本文件
```

## 云函数超时配置

| 云函数 | 超时 | 说明 |
|--------|------|------|
| `customers` / `followups` / `products` / `gifts` / `photos` / `ai_recommendations` / `ocr_records` / `recruit_candidates` / `recruit_followups` / `recruit_goals` | 10s | 常规 CRUD |
| `activity_reports` | 10s | 8 张表全量 select + JS 端聚合（rdb 无 in/聚合函数） |
| `ai_parse` / `ai_recommend` / `policy_review_reports` / `recruit_score` / `recruit_recommend` | **120s** | 调 hy3 AI 生成（解析/建议/检视/评分）|

## 云函数契约（event 入参 / result 出参）

所有函数入口签名：`exports.main = async (event, context) => result`
出错统一返回 `{ error: string }`。

### 1. customers

| action | 入参 | 出参 |
|--------|------|------|
| `list` | `{ action:'list', page?, pageSize?, keyword? }` | `{ rows, total, page, pageSize }` |
| `get` | `{ action:'get', id }` | `{ customer, followups, products, gifts, photos, recommendations }` |
| `create` | `{ action:'create', data:{ customer_name*, ... } }` | `{ id }` |
| `update` | `{ action:'update', id, data:{...} }` | `{ ok }` |
| `remove` | `{ action:'remove', id }` | `{ ok }`（软删除 `deleted_at`） |

`photos` 仅返回元数据（不含 base64），需单独调 `photos.get` 取图。
可填字段：`customer_name, sales_priority, recruitment_priority, referral_priority, hobbies, additional_info, gender, source, tags, marital_status, properties_info, occupation, annual_income, household_income, first_contact_date, birthday, customer_stage, phone`。

### 2. followups

| action | 入参 | 出参 |
|--------|------|------|
| `list` | `{ action:'list', customer_id }` | `{ rows }` |
| `create` | `{ action:'create', data:{ customer_id*, customer_name?, followup_notes, followup_date, next_followup_date, next_followup_goal } }` | `{ id }` |
| `update` | `{ action:'update', id, data:{...} }` | `{ ok }` |
| `remove` | `{ action:'remove', id }` | `{ ok }` |

`customer_name` 不填则自动从 customers 表查；`created_at`/`updated_at` 无默认值，函数内手动写入。

### 3. products

| action | 入参 | 出参 |
|--------|------|------|
| `list` | `{ action:'list', customer_id }` | `{ rows }`（0 或 1 行） |
| `upsert` | `{ action:'upsert', data:{ customer_id*, customer_name?, ap_ipa, ap_ltc, ap_ann, ap_life, ap_term, ap_wl, ap_pa, ap_ci, ap_hi, ap_all } }` | `{ id }` |
| `remove` | `{ action:'remove', id }` | `{ ok }` |

`ap_*` 均为 bigint，空串转 null。每客户一行：有则 UPDATE，无则 INSERT。

### 4. gifts

| action | 入参 | 出参 |
|--------|------|------|
| `list` | `{ action:'list', customer_id }` | `{ rows }` |
| `create` | `{ action:'create', data:{ customer_id*, customer_name?, gift_name*, quantity, notes, given_date } }` | `{ id }` |
| `update` | `{ action:'update', id, data:{...} }` | `{ ok }` |
| `remove` | `{ action:'remove', id }` | `{ ok }` |

### 5. photos

| action | 入参 | 出参 |
|--------|------|------|
| `list` | `{ action:'list', customer_id }` | `{ rows }`（仅元数据，**不含** photo_url） |
| `get` | `{ action:'get', id }` | `{ photo }`（含 `photo_url`，即 `data:image/...;base64,...`） |
| `create` | `{ action:'create', data:{ customer_id*, customer_name?, image_base64*, file_name?, content_type? } }` | `{ id }` |
| `remove` | `{ action:'remove', id }` | `{ ok }` |

`photos.id` 有序列默认值 `photos_id_seq`（insert 由数据库自动分配）。
`list` 不返回 `photo_url`（避免 base64 膨胀响应），前端按需调 `get` 懒加载。

### 6. ai_recommendations

| action | 入参 | 出参 |
|--------|------|------|
| `list` | `{ action:'list', customer_id }` | `{ rows }` |

只读。记录由 `ai_recommend` 写入。

### 7. ai_parse（hy3，120s）

| 入参 | 出参 |
|------|------|
| `{ text*, image_base64?, customer_id?, customer_name?, file_name?, content_type? }` | `{ parsed, raw, photo_id? }` |

- `text`：自然语言文本，必填
- `image_base64`：可选（不含 `data:` 前缀的纯 base64）；同时提供 `customer_id` 时存入 `photos` 表，**不调多模态**
- `parsed`：`{ customer_name, gender, phone, birthday, occupation, marital_status, customer_stage, sales_priority, hobbies, source, additional_info, ... }`，无法判断的字段为 `null`
- `raw`：模型原始输出文本
- `photo_id`：若存图则返回 `photos.id`

### 8. ai_recommend（hy3，120s）

| 入参 | 出参 |
|------|------|
| `{ customer_id* }` | `{ id, recommendation, raw }` |

- 自动拉取客户 + 最近 5 条跟进 + 产品额度 + 最近 5 条礼品 → 构建 prompt → hy3 生成
- `id`：`ai_recommendations.id`
- `recommendation`：`{ suggested_message, suggested_strategy, suggested_followup_date, suggested_customer_stage, suggested_followup_goal }`
- `raw`：模型原始输出文本

### 9. recruit_candidates（增员候选人，软删除 + funnel）

| action | 入参 | 出参 |
|--------|------|------|
| `list` | `{ action:'list', keyword?, stage?, page?, pageSize?, isSuper20? }` | `{ rows, total, page, pageSize }`（含 v_recruit_candidates 完整画像 JOIN） |
| `get` | `{ action:'get', id }` | `{ candidate, followups, milestones, score?, recommendation? }` |
| `create` | `{ action:'create', data:{ customer_id*, motivation?, concerns?, work_experience?, family_situation?, personality_tags?, career_plan?, source? } }` | `{ id }`（必须先有 customer 记录，customer_id NOT NULL） |
| `update` | `{ action:'update', id, data:{...} }` | `{ ok }`（stage 变更自动写 recruit_milestones） |
| `remove` | `{ action:'remove', id }` | `{ ok }`（软删除 deleted_at，关联子表级联标记） |
| `restore` | `{ action:'restore', id }` | `{ ok }`（清 deleted_at，子表同步恢复） |
| `funnel` | `{ action:'funnel' }` | `{ funnel:{阶段名:数量,...}, total }`（按 stage 分组，含 deleted_at IS NULL） |
| `rcMap` | `{ action:'rcMap' }` | `{ active:{Id:true,...}, deleted:{Id:true,...} }`（客户工作台"增员中"卡片用） |
| `listTrash` | `{ action:'listTrash', page?, pageSize?, keyword? }` | `{ rows }`（v_recruit_candidates_trash 视图） |

候选人与 customers **软关联**：customer_id NOT NULL（增员对象必先有客户记录）。重叠字段归 customers（姓名/电话/职业/学历/MBTI 等），recruit_candidates 只保留增员专属字段（动机/顾虑/工作经验/家庭情况/职业规划/下一步动作）。7 阶段枚举（text 列，便于演进）：新增人才 / 互动暖客 / 初次面谈 / 增员活动 / 精准面谈 / 入职申请 / 签约入司。

### 10. recruit_followups（增员跟进记录）

| action | 入参 | 出参 |
|--------|------|------|
| `list` | `{ action:'list', candidate_id }` | `{ rows }`（按 followup_date DESC, id DESC） |
| `create` | `{ action:'create', data:{ candidate_id*, contact_method*, interest_level?, followup_notes?, followup_date*, next_followup_date?, next_action? } }` | `{ id }` |
| `update` | `{ action:'update', id, data:{...} }` | `{ ok }` |
| `remove` | `{ action:'remove', id }` | `{ ok }`（**硬删除**，不进回收站） |

`contact_method` 枚举：电话 / 微信 / 面谈 / 线下活动 / 推荐人沟通 / 其他
`interest_level` 文本：极高 / 高 / 中 / 低 / 待观察

子表，软删除级联（主候选人 remove 时一并标记 deleted_at）。

### 11. recruit_goals（月度目标 + 行业基准对照）

| action | 入参 | 出参 |
|--------|------|------|
| `list` | `{ action:'list', month? }`（month 格式 `YYYY-MM`） | `{ rows }`（按 stage 阶段） |
| `upsert` | `{ action:'upsert', data:{ month*, stage*, target*, note? } }` | `{ id }` |
| `remove` | `{ action:'remove', id }` | `{ ok }` |
| `getProgress` | `{ action:'getProgress', startMonth, endMonth }` | `{ rows:[{stage,target,actual,achieve_rate}], overall:{target,actual,rate,bench:{min,avg,good}} }` |

`getProgress` 复用了 recruit_goal_benchmarks（7 阶段 min/avg/good + 来源标注）做整体漏斗对照；活动量日报的 goalProgress 字段也调它。

### 12. recruit_score（AI 高潜评分，hy3，120s）

| 入参 | 出参 |
|------|------|
| `{ candidate_id* }` | `{ potential_score, potential_reason, raw }` |

- 拉客户画像（年收入/职业/婚况/爱好/年龄）+ 增员专属字段（动机/顾虑/工作经验/家庭情况/性格标签/职业规划）
- **6 维度加权评分**：行业资源 / 学习能力 / 抗压能力 / 沟通能力 / 创业动机 / 文化适配（每维度 0-100）
- `potential_score`：综合分（0-100）
- `potential_reason`：评分理由文本（含各维度小分说明）
- 写入 `recruit_candidates.potential_score` + `potential_reason`

### 13. recruit_recommend（AI 接触建议，hy3，120s）

| 入参 | 出参 |
|------|------|
| `{ candidate_id*, operator? }` | `{ recommendation, raw }` |

- 拉客户画像 + 增员专属字段 + 最近跟进
- prompt 工程要点：
  - **称呼规则**：师兄/师弟（高校教师/MBTI 高 S）/ 先生/女士（企业主）
  - **STAR 异议框架**：情境/任务/行动/结果，四步应对常见异议
  - **五步接触法**：暖场 → 切入 → 探需 → 提案 → 收口
  - **行业话术锚点**：友邦/LIMRA/CareerPlug 的成功转化案例
- `recommendation`：`{ suggested_message, suggested_strategy, suggested_followup_date, suggested_next_action, objection_handler? }`
- 返回但不自动写库（用户在前端确认后手动采纳）

### 14. activity_reports（活动量日报，客户 + 增员双轨）

| action | 入参 | 出参 |
|--------|------|------|
| `customer` | `{ action:'customer', mode?:'today'\|'range', startDate?, endDate? }` | `{ mode, range:{start,end,days}, totals, daily, avg, overdueNow?, feed, feedTotal, generatedAt }` |
| `recruit` | `{ action:'recruit', mode?:'today'\|'range', startDate?, endDate? }` | `{ mode, range, totals, daily, avg, goalProgress?, feed, feedTotal, generatedAt }` |

**口径约定**：
- 活动归属按**业务发生日期**（followup_date / given_date / report_date / happened_at），无业务日期的按 created_at
- 时区按 **Asia/Shanghai** 切日
- 只统计 `deleted_at IS NULL` 的记录（软删除级联自动排除）
- `rdb` 无 in()/聚合函数 → 采用**全量 select + JS 端按日分桶**（与回收站 trashList 同模式，数据量级小）
- `mode='today'` 模式额外返回 `overdueNow`（客户：所有客户最新 next_followup_date 早于今天；增员无）
- `mode='range'` 必须 `startDate/endDate` 格式 `YYYY-MM-DD`，跨度 ≤ 366 天
- `feed` 为按时间倒序的活动流水（最多 300 条）

**客户侧 11 项 totals**：newCustomers / firstContacts / followups / customersTouched / plannedDue / completedPlan / completionRate / gifts / giftItems / photos / ocrParses / aiSuggestions / policyReviews
**增员侧 10 项 totals**：newCandidates / rcFollowups / candidatesTouched / plannedDue / completedPlan / completionRate / warm / firstInterview / event / deepInterview / apply / hired

### 15. policy_review_reports（保单检视报告，hy3，120s）

| action | 入参 | 出参 |
|--------|------|------|
| `list` | `{ action:'list', customer_id }` | `{ rows }`（按 report_date DESC, id DESC） |
| `get` | `{ action:'get', id }` | `{ report }` |
| `update` | `{ action:'update', id, data:{ edited_summary?, edited_gaps?, edited_recommendations?, edited_asset_allocation?, edited_next_action?, report_type?, report_date? } }` | `{ ok }`（编辑字段双写区） |
| `remove` | `{ action:'remove', id }` | `{ ok }`（**硬删除**） |
| `generate` | `{ action:'generate', customer_id, operator? }` | `{ id, report, raw }` |

**`generate` 流程**：
1. 拉客户 + 保单 + 最近 5 条跟进 + 最近 3 条礼品 + 最近 3 份历史报告 + 最近 3 张照片
2. 系统 prompt 内嵌**检视方法论**：
   - 保险需求金字塔（先保障后理财：定期寿险 → 重疾 → 医疗 → 意外 → 长护 → 终身寿 → 年金 → 万能 → PPA）
   - **双十原则**：合理总保额 ≈ 家庭年收入 × 10；合理总年交保费 ≈ 家庭年收入 × 10%（8%~15%，超 20% 提示保费压力）
   - 家庭责任期估算（到最小子女独立/房贷还清/父母赡养结束年数）
   - **标准普尔家庭资产象限图**（现金 10% / 保障 20% / 投资 30% / 保本 40%）
   - 险种结构健康度（保障型保额 ≥ 70% 总保额）
   - 家庭成员保障覆盖（防"经济支柱裸奔"）
3. hy3 输出 5 段 JSON：`summary` / `gaps_found` / `recommendations` / `asset_allocation` / `next_action`
4. 写库 + 返回 `id` + 完整 `report` + `raw`（原始输出，便于排查 JSON 解析失败）

**字段双写区**：AI 生成的 `*` 字段不可改，前端编辑后写入 `edited_*` 双写区，下次回访时 prompt 同时参考两者，呈现"已采纳建议 / 待补漏 / 新增变化"。

### 16. ocr_records（OCR 识别记录）

| action | 入参 | 出参 |
|--------|------|------|
| `list` | `{ action:'list', customer_id }` | `{ rows }`（按 created_at DESC，不含大文本截断） |
| `create` | `{ action:'create', data:{ customer_id*, summary?, raw_text?, file_ids?, file_names?, customer_snapshot? } }` | `{ id }` |
| `update` | `{ action:'update', id, data:{ summary?, raw_text? } }` | `{ ok }` |
| `remove` | `{ action:'remove', id }` | `{ ok, customer_snapshot }`（删除前返回 snapshot 供前端恢复） |

**核心设计 —— `customer_snapshot`**：AI 解析客户资料时，前端本地识别完整文字后，调用 `ai_parse`；**前端在用户确认保存到 photos 后**，将识别摘要 + 原文 + 关联文件 id + AI 解析前的客户信息快照一次性写入本表。这样：
- 客户详情"OCR 记录"页签可展示历史识别
- 可基于某条记录重新发起 AI 匹配更新客户信息
- 删除 OCR 记录时返回 `customer_snapshot`，前端可一键"还原到 AI 解析前"（误操作兜底）

`file_ids` / `file_names` 为 JSON 数组字符串（关联 photos 表的 id 与原始文件名）。

## 枚举值（PG 自定义类型）

- `客户经营阶段`：新认识 / 关系维护 / 需求挖掘 / 方案沟通 / 成交推进 / 转介绍经营
- `优先级`：A / B / C / D / E
- `跟进目标`：建立联系 / 约见面 / 邀请活动 / 获取家庭信息 / 推进签单 / 推进招募 / 推进转介绍

## 前端（admin.html）

- 单页 HTML，**单文件 4109 行 / 92 个函数 / 无构建步骤**
- `@cloudbase/js-sdk` CDN：`https://static.cloudbase.net/cloudbase-js-sdk/latest/cloudbase.full.js`
- `window.APP_CONFIG.envId` 填环境 ID（部署前修改）
- `apiBase` 留空：通过 `app.callFunction({ name, data })` 同域调用，不直连 PG/AI
- **用户名密码登录**（`auth.signInWithPassword`）：PG 模式下云函数 HTTP API 对匿名用户默认不放行（`EXCEED_AUTHORITY`），必须用注册用户登录后调用 callFunction；登录态由 SDK 本地持久化

### 顶栏模块切换

`<header>` 包含两个模块 Tab：
- **客户经营**（默认）→ 跳转 `#/`
- **组织发展** → 跳转 `#/recruit`

切换逻辑在 `route()` 函数中根据 hash 前缀自动归属（`#/recruit*` + `#/activity/recruit` 归组织发展，其余归客户经营）。

### 路由（10 条 hash 路径）

| 路由 | 归属模块 | 页面 |
|------|----------|------|
| `#/` | 客户经营 | 客户工作台（home，6 个统计卡 + 客户表） |
| `#/customers` | 客户经营 | 客户列表 |
| `#/customers/trash` | 客户经营 | 客户回收站（批量恢复） |
| `#/customer/:id` | 客户经营 | 客户详情（**7 Tab**：基本信息 / 跟进记录 / 保单检视 / 伴手礼 / 照片附件 / AI 解析记录 / AI 建议） |
| `#/ai-suggestions` | 客户经营 | AI 建议历史 |
| `#/activity/customer` | 客户经营 | 客户活动量日报 |
| `#/recruit` | 组织发展 | 增员工作台（7 阶段漏斗 + 候选人列表） |
| `#/recruit/goals` | 组织发展 | 目标管理（行业基准对比 + 当月目标对照） |
| `#/recruit/trash` | 组织发展 | 增员回收站 |
| `#/activity/recruit` | 组织发展 | 增员活动量日报（含 goalProgress 对照） |

### 工具栏按钮

- **客户工作台** 工具栏（9 个按钮）：搜索框 / 搜索 / + 新增客户 / 全部客户 / AI 解析新增 / AI 建议 / 活动量 / 客户列表 / 客户工作台（已删除"增员"按钮 — 已迁到组织发展）
- **增员工作台** 工具栏（6 个按钮）：搜索框 / 搜索 / + 新增候选人 / 目标管理 / 活动量 / 回收站

### 照片上传

FileReader → base64 → `photos.create`；显示：`photos.get` 懒加载 data URL。

### 增员文件上传

`bucket: recruit`（私有），对象路径 `candidate_<id>/radar_*.{ext}` 与 `candidate_<id>/winner_report_*`；signed URL 1 小时有效。

## 数据库安全（RLS）

共享集群 PG 的 REST API（`https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/...`）默认对匿名 token（`role=anon`）开放，且云函数 `app.rdb()` 的实际身份也是 `anon`。为防止任何人匿名 REST 直读客户数据，**13 张业务表全部启用 RLS**（6 张客户域 + 2 张画像增强 + 5 张增员域），policy 统一为：

- 客户域（6）：customers / followups / products / gifts / photos / ai_recommendations
- 画像增强（2）：policy_review_reports / ocr_records
- 增员域（5）：recruit_candidates / recruit_milestones / recruit_followups / recruit_goals / recruit_goal_benchmarks

具体迁移：`cloudbase/migrations/20260905170000_recruit_security_baseline.sql`（与 customers_fn_only 逐字一致的 recruit_*_fn_only 策略）。

```sql
-- 每张表：customers_fn_only / followups_fn_only / ...（TO anon, FOR ALL）
USING (current_setting('request.jwt.claims', true)::json->>'sub' IS NULL
   AND current_setting('request.jwt.claims', true)::json->>'role' = 'anon')
WITH CHECK (同上)
```

原理：云函数 token **不含 `sub`**（仅 `aud/exp/iat/iss/role`），而任何用户 token（匿名 REST / js-sdk 登录）都带 `sub`。同时：

- `GRANT SELECT, INSERT, UPDATE, DELETE` 已授予 anon（表级放行，行级由上述 policy 收口）
- 6 张 `*_view` 视图已 `REVOKE anon`（视图以 owner 身份执行会绕过表 RLS，是第二条泄漏路径）
- 依赖 `@cloudbase/node-sdk@^4`（4.x 才有 `rdb()`；3.x 无）

已验证：云函数正常读写 761 条客户；匿名 REST 读表/读视图均返回空或 `permission denied`。

## 部署步骤

1. **配置环境变量**：在 CloudBase 控制台为每个云函数注入 `TCB_ENV`（环境 ID）。**5 个 AI 函数**（`ai_parse` / `ai_recommend` / `policy_review_reports` / `recruit_score` / `recruit_recommend`）额外注入 `AI_MODEL=hy3`。**不需要任何 PG_* 变量**（共享集群无 PG 协议直连）。
2. **打包共享模块**：将 `_shared/db.js` 复制到每个云函数目录（源码已直接 `require('./db')`）：
   ```bash
   for d in $(ls cloudfunctions/ | grep -v _shared); do
     cp cloudfunctions/_shared/db.js "cloudfunctions/$d/db.js"
   done
   ```
   （当前 16 个函数都需同步；本项目另有 `.deploy/<func>/` 目录为最终部署产物，与 `cloudfunctions/` 源码保持一致）
3. **部署云函数**：`tcb fn deploy <name>` 或控制台上传各目录（超时：`ai_parse` / `ai_recommend` / `policy_review_reports` / `recruit_score` / `recruit_recommend` = **120s**，其余 10s；依赖 `@cloudbase/node-sdk@^4.0.3` 云端安装）
4. **部署前端**：`tcb hosting deploy admin.html`（或控制台静态托管上传 `admin.html`，并填入 `envId`）；**单文件无构建步骤**
5. **创建登录用户**：`managePermissions(action="createUser", username=..., password=...)` 或控制台「身份认证 → 用户管理」创建（PG 模式 HTTP API 不支持纯用户名密码自助注册）。当前账号：`crm_admin`
6. **网关 OPA 策略**（已配置）：`authz.user.rego` 显式 `deny` 匿名/未登录用户调用 functions（纵深防御；注册用户由平台默认策略放行）
7. **端到端验证**：打开 admin.html → 登录 → **客户工作台** → 新增客户 → 详情各 Tab（7 个）→ AI 解析 / AI 建议 → 切换到**组织发展** → 增员工作台 → 目标管理 → 活动量日报 → 客户/增员回收站

## 硬性限制

- AI 仅 hy3，`app.ai().createModel('cloudbase')`，`AI_MODEL=hy3`
- 禁止 deepseek / openai / 任何第三方 Key
- 禁止前端直连 PG 或 AI
- 数据访问仅 `app.rdb()`（node-sdk 4.x），无 PG 凭证、无 VPC
- **13 张业务表**（6 张客户域 + 2 张画像增强 + 5 张增员域）RLS policy 仅放行云函数 token（无 `sub`），不得建 `TO anon USING (true)` 类过宽 policy；不得对 anon 授予 6 张 `*_view` 视图 SELECT（owner 身份执行会绕过表 RLS，是第二条泄漏路径）
- 照片 base64 存 `photos` 表，不调多模态，不开云存储匿名登录
- 不启用 VPC
