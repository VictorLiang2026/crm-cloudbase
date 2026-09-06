# CRM 架构单页图（v2.0 现状）

> 最后更新：2026-09-06
> 配套：[`SPEC-v2.md`](../../SPEC-v2.md)（技术规格） / [`README.md`](../../README.md)（云函数契约）
> 本文档目的：**一页看懂 CRM 的整体结构**。改架构前先翻这里。

---

## 一、整体架构图

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         admin.html (单文件约 3900 行)                         │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │ <header>                                                           │     │
│  │   [V] Victor's CRM    env:crm-d1gkae8ddc930d151                    │     │
│  │   [客户经营] [组织发展]   ← 模块切换器（点击切换）                  │     │
│  └──────────────────────────────────────────────────────────────────┘     │
│                                                                            │
│  路由（10 条 hash 路径）：                                                  │
│   #/                          → 客户工作台（home）                          │
│   #/customers                 → 客户列表                                     │
│   #/customers/trash           → 客户回收站                                   │
│   #/customer/:id              → 客户详情（7 Tab）                           │
│   #/ai-suggestions            → AI 建议历史                                  │
│   #/activity/customer         → 客户活动量日报                               │
│   #/recruit                   → 增员工作台（漏斗+列表）                      │
│   #/recruit/goals             → 目标管理（行业基准对比）                     │
│   #/recruit/trash             → 增员回收站                                   │
│   #/activity/recruit          → 增员活动量日报                               │
└────────────────────────────────────────────────────────────────────────────┘
                                      │ app.callFunction({ name, data })
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│             CloudBase 事件云函数 ×16 (Nodejs18.15, CommonJS)               │
│                                                                            │
│  客户域 CRUD (5)            AI 生成 (3)         画像增强 (2)              │
│   ├─ customers               ├─ ai_parse(120s)    ├─ policy_review(120s)  │
│   ├─ followups               ├─ ai_recommend(120s)├─ ocr_records           │
│   ├─ products                └─ ai_recommendations                       │
│   ├─ gifts                      (只读)            活动量日报 (1)         │
│   └─ photos                                        └─ activity_reports   │
│                                                                            │
│  增员域 (5)                                                                     │
│   ├─ recruit_candidates    (含 funnel action)                                  │
│   ├─ recruit_followups                                                            │
│   ├─ recruit_goals        (含 getProgress)                                       │
│   ├─ recruit_score(120s)  (AI 高潜评分)                                          │
│   └─ recruit_recommend(120s) (AI 接触建议)                                        │
│                                                                            │
│  共享模块：                                                                   │
│   _shared/db.js → rdb() + AI(hy3) + assertOk + extractJson + normFields   │
└────────────────────────────────────────────────────────────────────────────┘
          │                              │
          ▼                              ▼
┌──────────────────────┐    ┌─────────────────────────────────────┐
│  CloudBase Storage   │    │   PostgreSQL 共享集群 SHARED        │
│  bucket: recruit     │    │   (envId: crm-d1gkae8ddc930d151)    │
│  (私有, signed URL)  │    │                                      │
│  ├─ candidate_<id>/  │    │   业务表 (13 BASE TABLE)：           │
│  │  ├─ radar_*        │    │   ├─ customers       (761 行)        │
│  │  └─ winner_report_*│    │   ├─ followups       (220 行)        │
│                       │    │   ├─ products        (0 行 ⚠)       │
│                       │    │   ├─ gifts           (188 行)        │
│                       │    │   ├─ photos          (0 行 ⚠)       │
│                       │    │   ├─ ai_recommendations (11 行)    │
│                       │    │   ├─ policy_review_reports          │
│                       │    │   ├─ ocr_records                    │
│                       │    │   ├─ recruit_candidates (4 行 ⚠)   │
│                       │    │   ├─ recruit_milestones (4 行)     │
│                       │    │   ├─ recruit_followups (0 行 ⚠)   │
│                       │    │   ├─ recruit_goals     (0 行 ⚠)   │
│                       │    │   └─ recruit_goal_benchmarks (7行) │
│                       │    │                                      │
│                       │    │   视图 (8 VIEW)：                    │
│                       │    │   ├─ 6 × *_view（REVOKE anon）       │
│                       │    │   ├─ v_recruit_candidates            │
│                       │    │   └─ v_recruit_candidates_trash      │
│                       │    │                                      │
│                       │    │   RLS：13 张表全部 fn_only 策略      │
│                       │    │   （仅云函数 token 无 sub 可访问）   │
└──────────────────────┘    └─────────────────────────────────────┘
                                            │
                                            ▼
                            ┌──────────────────────────────────┐
                            │   AI: hy3（cloudbase 组）        │
                            │   Status = 1                     │
                            │   仅 ai_parse / ai_recommend /  │
                            │   policy_review_reports /         │
                            │   recruit_score / recruit_recommend│
                            │   共 5 个函数调用                  │
                            └──────────────────────────────────┘
```

---

## 二、双模块映射（业务域 ↔ 云函数 ↔ 表）

| 模块 | 子页面 | 路由 | 主云函数 | 关键表 | 关键视图 |
|------|--------|------|----------|--------|----------|
| **客户经营** | 客户工作台 | `#/` | `customers` / `ai_recommendations` | `customers` / `followups` / `ai_recommendations` | — |
|  | 客户列表 | `#/customers` | `customers` | `customers` | — |
|  | 客户详情（7 Tab） | `#/customer/:id` | `customers` + 7 个子模块 | + 全部 6 张客户域表 | — |
|  | AI 建议历史 | `#/ai-suggestions` | `ai_recommendations` | `ai_recommendations` | — |
|  | 客户活动量日报 | `#/activity/customer` | `activity_reports` (action: customer) | 聚合 7 张客户表 | — |
|  | 客户回收站 | `#/customers/trash` | `customers` (listTrash/restore/purge) | `customers` + 7 张子表级联 | — |
| **组织发展** | 增员工作台 | `#/recruit` | `recruit_candidates` (funnel + list) | `recruit_candidates` | `v_recruit_candidates` |
|  | 增员详情 | `#/recruit/:id` | `recruit_candidates` + `recruit_followups` + `recruit_score` + `recruit_recommend` | 4 张增员表 | `v_recruit_candidates` |
|  | 目标管理 | `#/recruit/goals` | `recruit_goals` + `recruit_candidates` | `recruit_goals` + `recruit_goal_benchmarks` | — |
|  | 增员活动量日报 | `#/activity/recruit` | `activity_reports` (action: recruit) | 聚合 3 张增员表 | — |
|  | 增员回收站 | `#/recruit/trash` | `recruit_candidates` (listTrash/restore/purge) | `recruit_candidates` 级联 | `v_recruit_candidates_trash` |

---

## 三、数据流（一次典型操作的完整链路）

### 场景 A：新增客户并触发 AI 解析

```
[用户]
  │ 在客户工作台点 "AI 解析新增"
  ▼
[admin.html]
  │ openAiParse() 弹出文本框
  │ 用户粘贴一段名片信息文本
  │ 提交时调 callFn('ai_parse', { text, customer_id? })
  ▼
[ai_parse 云函数]
  │ 1. 校验 text
  │ 2. 若有 customer_id，写 photos 表（image_base64 入库）
  │ 3. generateText([system: 解析规则, user: 文本])
  │     ↓
  │     [hy3] 返回 JSON（customer_name / phone / ...）
  │ 4. extractJson(raw) → parsed
  │ 5. 返回 { parsed, raw, photo_id? }
  ▼
[admin.html]
  │ 解析结果回填 → 用户确认 → openCustomerForm(parsed)
  │ 提交 → callFn('customers', { action:'create', data:parsed })
  ▼
[customers 云函数]
  │ INSERT INTO customers (...) RETURNING id
  ▼
[PG] customers 表新增一行
```

### 场景 B：增员候选人阶段推进（带 AI 评分）

```
[用户在增员详情页]
  │ 修改 stage = "互动暖客" + 点 "AI 评分"
  ▼
[admin.html]
  │ callFn('recruit_candidates', { action:'update', id, data:{ stage } })
  │ callFn('recruit_score', { candidate_id })
  ▼
[recruit_candidates 云函数]
  │ UPDATE stage, stage_changed_at=now()
  │ INSERT INTO recruit_milestones (from_stage, to_stage, '互动暖客')
  ▼
[recruit_score 云函数]
  │ 拉客户画像 + 6 维度加权
  │ generateText → { potential_score, reason }
  │ UPDATE recruit_candidates SET potential_score=..., potential_reason=...
  ▼
[admin.html]
  │ 页面刷新显示新评分 + 雷达图
```

### 场景 C：客户活动量日报（today 模式）

```
[用户在活动量日报页]
  ▼
[admin.html]
  │ callFn('activity_reports', { action:'customer', mode:'today' })
  ▼
[activity_reports 云函数]
  │ Promise.all([
  │   customers, followups, gifts, photos,
  │   ocr_records, ai_recommendations,
  │   policy_review_reports, products
  │ ])  ← 8 张表全量 select + JS 端按日分桶
  │
  │ 聚合 11 项 totals：
  │   newCustomers, firstContacts,
  │   followups, customersTouched,
  │   plannedDue, completedPlan, completionRate,
  │   gifts, giftItems, photos,
  │   ocrParses, aiSuggestions, policyReviews
  │
  │ 计算 overdueNow（today 模式才有）：
  │   客户最新一条 followup.next_followup_date < today 的总数
  │
  │ 返回 { mode, range, totals, daily, avg, overdueNow, feed }
  ▼
[admin.html]
  │ renderActivityPage(...) 按"开拓/接触跟进/主顾经营动作"分组渲染
```

---

## 四、关键技术约束（v2 与 v1 一致）

| 约束 | 实现 |
|------|------|
| **AI 模型** | 仅 `hy3`（`cloudbase` 组），通过 `app.ai().createModel('cloudbase').generateText({ model:'hy3' })` |
| **禁止第三方 Key** | 无 deepseek/openai/任何外部 AI Key；前端不直连外部 AI |
| **数据访问** | 仅 `app.rdb()`（node-sdk 4.x），无 PG 凭证（PGHOST/PGPORT/... 已弃用） |
| **网络** | 共享集群 PG（SHARED），**不启用 VPC** |
| **照片存储** | base64 存 `photos` 表（data URL 形式），**不调多模态**，不开云存储匿名登录 |
| **文件存储** | 增员文件走 `bucket: recruit`（私有，signed URL 1h 有效） |
| **SQL** | 全部参数化（`$1, $2, ...`），空串统一转 null |
| **认证** | 用户名+密码（`auth.signInWithPassword`），PG 模式不支持自助注册 |
| **网关** | `authz.user.rego` deny 匿名调用（纵深防御） |

---

## 五、RLS baseline（已启用 13 张表）

每张表的 policy 统一为 `<table>_fn_only`：

```sql
USING (current_setting('request.jwt.claims', true)::json->>'sub' IS NULL
   AND current_setting('request.jwt.claims', true)::json->>'role' = 'anon')
WITH CHECK (同上)
```

**原理**：云函数 token 不含 `sub`，而任何用户 token（匿名 REST / js-sdk 登录）都带 `sub`。

| 类别 | 表名 | policy 名 |
|------|------|-----------|
| 客户域（6） | customers / followups / products / gifts / photos / ai_recommendations | `*_fn_only` |
| 画像增强（2） | policy_review_reports / ocr_records | `*_fn_only` |
| 增员域（5） | recruit_candidates / recruit_milestones / recruit_followups / recruit_goals / recruit_goal_benchmarks | `recruit_*_fn_only` |
| 视图（2） | v_recruit_candidates / v_recruit_candidates_trash | `GRANT SELECT TO anon`（基表已 RLS，安全） |
| 视图（6） | 6 张 `*_view` | **`REVOKE anon`**（防 owner 身份绕过 RLS）|

---

## 六、部署快照（已就绪）

| 项 | 状态 | 备注 |
|---|---|---|
| 16 个云函数 | ✅ 全部 Active | 8-18 ~ 9-05 陆续部署 |
| 13 张业务表 + 8 视图 | ✅ 全部存在 | 16 个迁移 SQL 已执行（cloudbase/migrations/） |
| RLS | ✅ 13 张全部启用 + fn_only policy | 详见 `cloudbase/migrations/20260905170000_recruit_security_baseline.sql` |
| 软删除级联 | ✅ 7 张子表 + deleted_at | 详见 `cloudbase/migrations/20260905190000_recycle_bin_soft_delete.sql` |
| 数据快照 | ✅ `backups/db_snapshot_20260904.sql` | 增员模块数据快照 |
| 登录账号 | ✅ `crm_admin` | PG 模式手动创建 |
| 网关 OPA | ✅ `authz.user.rego` | 显式 deny 匿名 |

---

## 七、本图维护规则

1. **任何云函数/表/视图新增或删除**，本图 + `SPEC-v2.md` + `README.md` **同步更新**
2. **任何 RLS policy 变更**，本图第五章 + `cloudbase/migrations/` 必须同步
3. **任何阶段名变更**（如 `20260905160200_recruit_stages_update.sql`），SPEC-v2 与 README 中阶段列表同步更新
4. **任何部署时间变更**，SPEC-v2 表中"部署日期"列同步更新

---

**当前版本**：v2.0
**配套**：[`SPEC-v2.md`](../../SPEC-v2.md) / [`README.md`](../../README.md)