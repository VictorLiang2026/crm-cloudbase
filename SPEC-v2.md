# 个人 CRM — 技术规格 v2.0

> CloudBase 个人版 + 事件云函数 + 共享集群 PostgreSQL 的个人 CRM 系统。
> **v2.0 现状规格**（2026-09-06 重写）—— 对应已部署 **16 个云函数 / 13 张业务表 / 8 个视图**。
> v1 见 [`SPEC-v1.md`](./SPEC-v1.md)（早期 6 张表 / 8 云函数 + PGHOST 直连方案，已弃用）。

## 环境

| 项 | 值 |
|---|---|
| EnvId | `crm-d1gkae8ddc930d151` |
| Alias | `crm` |
| Region | `ap-shanghai` |
| PackageId | `baas_personal`（个人版，资源点模式） |
| 后端 | PostgreSQL **共享型 SHARED**，**不启用 VPC** |
| AI | **hy3**（`cloudbase` 组，`Status=1`） |
| 静态托管 | `crm-d1gkae8ddc930d151-1434199662.tcloudbaseapp.com` |
| 登录账号 | `crm_admin`（PG 模式不支持自助注册，需手动 createUser） |
| 网关 | `authz.user.rego` 显式 deny 匿名/未登录用户调用 functions |

## 架构（一张图）

```
admin.html (单页, @cloudbase/js-sdk CDN, callFunction 同域)
  ├─ 顶栏 [客户经营] [组织发展] 模块切换器
  ├─ 路由：#/, #/customers, #/customers/trash, #/customer/:id (7 Tab),
  │        #/ai-suggestions, #/activity/customer,
  │        #/recruit, #/recruit/goals, #/recruit/trash, #/activity/recruit
  └─ window.APP_CONFIG.envId（部署前填入）
        │
事件云函数 ×16 (CommonJS, Nodejs18.15)
  ├─ _shared/db.js（rdb() 数据访问 + AI(hy3) 封装；部署时复制为各函数 ./db.js）
  └─ @cloudbase/node-sdk@^4
       └─ app.rdb()                          → 共享集群 PG（RLS fn_only）
       └─ app.ai().createModel('cloudbase')  → hy3（5 个 AI 函数：ai_parse / ai_recommend /
                                                   policy_review_reports / recruit_score / recruit_recommend）
```

**边界**：前端不直连 PG，不直连 AI。所有 PG 访问与 AI 调用都在云函数内完成。
照片 base64 存 `photos` 表（`photo_url` = data URL），不调多模态，不开云存储匿名登录。
不启用 VPC，不填 VPC ID / 子网。

## 16 个事件云函数（已部署，全部 Active）

按业务域分组（部署时间倒序）：

| 业务域 | 云函数 | 超时 | 部署日期 | 说明 |
|--------|--------|------|----------|------|
| **客户域 CRUD** | `customers` | 10s | 2026-08-18 | 客户 CRUD（list/get/create/update/remove） |
|  | `followups` | 10s | 2026-08-18 | 跟进记录 CRUD |
|  | `products` | 10s | 2026-08-18 | 保单额度 upsert（每客户一行，11 个 ap_* bigint + items JSON） |
|  | `gifts` | 10s | 2026-08-18 | 伴手礼 CRUD |
|  | `photos` | 10s | 2026-08-18 | 照片存储（base64 → photos 表，list 只返元数据，get 返 data URL） |
| **AI 历史** | `ai_recommendations` | 10s | 2026-08-18 | AI 建议历史（只读；`list` 按客户 / `listAll` 分页排序+姓名与日期区间筛选） |
| **AI 生成** | `ai_parse` | **120s** | 2026-08-18 | AI 文本解析 → 客户资料（hy3），可选存图 |
|  | `ai_recommend` | **120s** | 2026-08-18 | AI 跟进建议生成（hy3）→ 写 ai_recommendations |
| **画像增强** | `policy_review_reports` | **120s** | 2026-09-03 | 保单检视报告 5 段 AI 生成（标准普尔+双十原则+保险金字塔方法论）|
|  | `ocr_records` | 10s | 2026-08-29 | OCR 识别记录（带 customer_snapshot，可恢复）|
| **活动量日报** | `activity_reports` | 10s | 2026-09-05 | today / range 模式；客户+增员双轨聚合 |
| **增员域** | `recruit_candidates` | 10s | 2026-09-03 | 候选人 CRUD + 漏斗 + funnel |
|  | `recruit_followups` | 10s | 2026-09-04 | 增员跟进（contact_method / interest_level / 顾虑） |
|  | `recruit_goals` | 10s | 2026-09-04 | 月度目标 + getProgress（与 recruit_goal_benchmarks 对照） |
|  | `recruit_score` | **120s** | 2026-09-03 | AI 高潜评分（6 维度加权） |
|  | `recruit_recommend` | **120s** | 2026-09-03 | AI 接触建议（含 STAR 异议处理 + 称呼规则 + 五步法）|

> **数量说明**：v1 列了 8 个云函数，v2 实际部署 16 个（含保单检视/OCR/活动量日报/增员 5 个）。
> 用户给的需求口径是"15 云函数"，本规格按实际清单写。

详细契约见 [`README.md`](./README.md)（按云函数分章节，含每个 action 的入参/出参）。

## 13 张业务表 + 8 个视图

### 业务表（按业务域分组）

| 业务域 | 表名 | 主键 | 说明 |
|--------|------|------|------|
| **客户域** | `customers` | `Id`（大写 I, integer, IDENTITY BY DEFAULT） | 中心表，761 行活数据；含 sales_priority / recruitment_priority / referral_priority / education / mbti |
|  | `followups` | `Id`（大写 I, integer, IDENTITY BY DEFAULT） | 220 行；含 followup_notes / next_followup_date / next_followup_goal |
|  | `products` | `id`（小写, bigint, IDENTITY BY DEFAULT） | 保单额度（11 个 ap_* + items JSON 明细） |
|  | `gifts` | `Id`（大写 I, bigint, IDENTITY BY DEFAULT） | 188 行 |
|  | `photos` | `id`（小写, integer, **无序列手动分配**） | base64 → data URL；list 不返 photo_url |
|  | `ai_recommendations` | `id`（小写, bigint, IDENTITY BY DEFAULT） | 只读表，由 ai_recommend 写入 |
| **画像增强** | `policy_review_reports` | `id`（bigint, IDENTITY BY DEFAULT） | 5 段检视 AI 报告（summary / gaps_found / recommendations / asset_allocation / next_action）+ edited_* 双写区 |
|  | `ocr_records` | `id`（bigint, IDENTITY BY DEFAULT） | OCR 记录 + customer_snapshot（删除可恢复） |
| **增员域** | `recruit_candidates` | `id`（bigserial） | 7 阶段（新增人才→互动暖客→初次面谈→增员活动→精准面谈→入职申请→签约入司）|
|  | `recruit_milestones` | `id`（bigserial） | 阶段变更事件流（候选时间线） |
|  | `recruit_followups` | `id`（bigserial） | 增员接触记录（含 contact_method / interest_level） |
|  | `recruit_goals` | `id`（bigserial） | 月度目标 |
|  | `recruit_goal_benchmarks` | `id`（serial） | 行业基准（7 阶段 min/avg/good + 来源） |

### 视图

| 视图 | 用途 |
|------|------|
| `customers_view` / `followups_view` / `gifts_view` / `photos_view` / `products_view` / `ai_recommendations_view` | 6 张配套视图（已 `REVOKE anon`，以防 owner 身份绕过 RLS）|
| `v_recruit_candidates` | 增员候选人完整画像 JOIN customers（含 idle_days 列）|
| `v_recruit_candidates_trash` | 增员回收站（软删除候选人 + 客户基础信息）|

### 枚举类型（PG 自定义）

- `客户经营阶段`：新认识 / 关系维护 / 需求挖掘 / 方案沟通 / 成交推进 / 转介绍经营
- `优先级`：A / B / C / D / E
- `跟进目标`：建立联系 / 约见面 / 邀请活动 / 获取家庭信息 / 推进签单 / 推进招募 / 推进转介绍

> 增员阶段不强制使用枚举，采用 text 列 + 应用层约束（便于阶段名演进，如 `20260905160200_recruit_stages_update.sql` 的旧→新阶段映射）。

## 数据库安全（RLS）

共享集群 PG 的 REST API（`https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/...`）默认对匿名 token（`role=anon`）开放，且云函数 `app.rdb()` 的实际身份也是 `anon`。为防止任何人匿名 REST 直读客户数据，**13 张业务表全部启用 RLS**（6 张客户域 + 2 张画像增强 + 5 张增员域），policy 统一为：

```sql
-- 每张表：<table>_fn_only（TO anon, FOR ALL）
USING (current_setting('request.jwt.claims', true)::json->>'sub' IS NULL
   AND current_setting('request.jwt.claims', true)::json->>'role' = 'anon')
WITH CHECK (同上)
```

原理：云函数 token **不含 `sub`**（仅 `aud/exp/iat/iss/role`），而任何用户 token（匿名 REST / js-sdk 登录）都带 `sub`。同时：

- `GRANT SELECT, INSERT, UPDATE, DELETE` 已授予 anon（表级放行，行级由上述 policy 收口）
- 6 张 `*_view` 视图已 `REVOKE anon`（视图以 owner 身份执行会绕过表 RLS，是第二条泄漏路径）
- 2 张增员视图（`v_recruit_candidates` / `v_recruit_candidates_trash`）显式 `GRANT SELECT TO anon`，因为 RLS 已在基表生效，视图读出来的就是已经过滤过的安全数据
- 依赖 `@cloudbase/node-sdk@^4`（4.x 才有 `rdb()`；3.x 无）

**已启 RLS 的 13 张业务表**：
customers / followups / products / gifts / photos / ai_recommendations /
policy_review_reports / ocr_records /
recruit_candidates / recruit_milestones / recruit_followups / recruit_goals / recruit_goal_benchmarks
（统一 fn_only 策略，详见 `cloudbase/migrations/20260905170000_recruit_security_baseline.sql` 与 `20260905171000_ocr_records_rls.sql`）

已验证：云函数正常读写 761 条客户；匿名 REST 读表/读视图均返回空或 `permission denied`。

## 软删除 / 回收站语义

- **应用内直接删除子记录**（跟进 / 礼品 / 照片 / 报告 / AI 解析记录 / 产品额度 / 增员跟进）= **硬删除**（各云函数 remove 保持 DELETE 不变，**不进**回收站）
- **删除客户 / 增员候选人**（主对象）= **级联软删除**（打 deleted_at 标记，关联子记录一并标记，可从回收站恢复）

子表 deleted_at 字段由 `cloudbase/migrations/20260905190000_recycle_bin_soft_delete.sql` 一次性补齐（7 张子表：followups / gifts / photos / policy_review_reports / ocr_records / products / recruit_followups）。

## 部署步骤

1. **配置环境变量**：在 CloudBase 控制台为每个云函数注入 `TCB_ENV`（环境 ID）。AI 函数额外注入 `AI_MODEL=hy3`。**不需要任何 PG_* 变量**（共享集群无 PG 协议直连，全部走 `app.rdb()`）。
2. **打包共享模块**：将 `_shared/db.js` 复制到每个云函数目录（源码已直接 `require('./db')`）：
   ```bash
   for d in $(ls cloudfunctions/ | grep -v _shared); do
     cp cloudfunctions/_shared/db.js "cloudfunctions/$d/db.js"
   done
   ```
   （当前 16 个函数都需同步）
3. **部署云函数**：`tcb fn deploy <name>` 或控制台上传各目录（超时：ai_parse / ai_recommend / policy_review_reports / recruit_score / recruit_recommend = 120s，其余 10s；依赖 `@cloudbase/node-sdk@^4.0.3` 云端安装）
4. **部署前端**：`tcb hosting deploy ./admin.html /crm-v1/admin.html -e crm-d1gkae8ddc930d151 --yes`（或控制台静态托管上传到 `crm-v1/` 目录，并填入 `envId`）；**单文件无构建步骤**，访问地址 `.../crm-v1/admin.html`（多系统按目录隔离）
5. **创建登录用户**：`managePermissions(action="createUser", username=..., password=...)` 或控制台「身份认证 → 用户管理」创建（PG 模式 HTTP API 不支持纯用户名密码自助注册）。当前账号：`crm_admin`
6. **网关 OPA 策略**（已配置）：`authz.user.rego` 显式 `deny` 匿名/未登录用户调用 functions（纵深防御；注册用户由平台默认策略放行）
7. **端到端验证**：打开 admin.html → 登录 → 客户工作台 → 新增客户 → 详情各 Tab → AI 解析 / AI 建议 → 切换到"组织发展" → 增员工作台 → 目标管理 → 活动量日报 → 客户/增员回收站

> **日常迭代发布**（非首次部署）：改代码 → MCP 部署云函数/托管 → `tools/release.ps1` 一键提交推送（可带 `-Tag vX.Y.Z`）→ `tools/sync-check.ps1` 三方体检。完整流程见 [`README.md`](./README.md)「发布与版本管理」章节。

## 硬性限制（v2 与 v1 一致）

1. **AI 只用 hy3**：`app.ai().createModel('cloudbase')` + `generateText({ model: 'hy3' })`。
2. **禁止第三方 Key**：无 deepseek/openai/任何外部 AI Key；禁止前端直连外部 AI。
3. **数据访问仅 `app.rdb()`（node-sdk 4.x），无 PG 凭证、无 VPC**：
   - v1 的 `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD` 已弃用（共享集群无 PG 协议直连）
   - v2 仅需 `TCB_ENV` 和 `AI_MODEL=hy3`
4. **照片 base64 存 `photos` 表**，不调多模态，不开云存储匿名登录。
5. **所有 SQL 参数化**：`$1, $2, ...`，空串统一转 null。
6. **不启用 VPC**：共享集群 PG，`ssl=false`，云函数走内网。
7. **admin.html `apiBase` 留空**：通过 `callFunction` 同域调用。
8. **13 张业务表 RLS baseline**（6 张客户域 + 2 张画像增强 + 5 张增员域）：不得建 `TO anon USING (true)` 类过宽 policy；不得对 anon 授予 6 张 `*_view` 视图 SELECT。

## v1 → v2 变更摘要

| 维度 | v1 | v2 |
|------|----|----|
| 云函数 | 8 | **16**（新增 8 个） |
| 业务表 | 6 | **13**（新增 7 张） |
| 视图 | 6 `*_view` | **8**（新增 2 张增员视图） |
| 数据访问 | `pg.Pool` + PGHOST 凭证 | **`app.rdb()`**（无凭证） |
| 模块架构 | 单一客户域 | **双模块**（客户经营 + 组织发展） |
| 路由 | 4 个 | **10 个** |
| 客户详情 Tab | 3 个 | **7 个**（+保单检视/OCR记录/AI建议） |
| 阶段模型 | 单一客户阶段 | **客户阶段（6 段）+ 增员阶段（7 段）** |
| 行业基准 | 无 | **7 阶段 min/avg/good + 来源标注** |
| 软删除 | 仅 customers | **7 张子表 + 主对象级联** |
| 回收站 | 仅客户 | **客户域 + 增员域双轨** |
| 活动量日报 | 无 | **客户 + 增员双轨（today/range 模式）** |
| 保单检视 | 无 | **AI 5 段报告（120s 方法论 prompt）** |
| OCR | 无 | **带 customer_snapshot 回退** |

## 禁止

- 前端出现 `PGHOST` / `PGPASSWORD` / 任何 PG 凭证（v1 已废弃）
- 前端 `fetch('https://api.openai.com/...')` 或任何第三方 AI 端点
- 字符串拼接 SQL
- 照片 OCR / 图像识别 / 多模态调用
- `createModel('deepseek')` / `createModel('openai')` 等 vendor 名
- 启用 VPC
- 对 6 张 `*_view` 视图 GRANT anon SELECT

---

**当前版本**：v2.0（2026-09-06 重写）
**维护者**：Victor
**配套文档**：[README.md](./README.md)（云函数契约 + 发布与版本管理）/ [docs/architecture-current.md](./docs/architecture-current.md)（单页架构图）/ [tools/release.ps1](./tools/release.ps1)、[tools/sync-check.ps1](./tools/sync-check.ps1)（发布与体检脚本）