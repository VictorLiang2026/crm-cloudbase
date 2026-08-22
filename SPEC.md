# 个人 CRM — 技术规格

> CloudBase 个人版 + 事件云函数 + 共享集群 PostgreSQL 的个人 CRM 系统。

## 环境

| 项 | 值 |
|---|---|
| EnvId | `crm-d1gkae8ddc930d151` |
| Alias | `crm` |
| Region | `ap-shanghai` |
| PackageId | `baas_personal`（个人版，资源点模式） |
| 后端 | PostgreSQL（共享型 SHARED，**不启用 VPC**） |
| AI | `hy3`（`cloudbase` 组，`Status=1`） |

## 架构

```
admin.html (单页, @cloudbase/js-sdk CDN, callFunction 同域)
  ├─ app.callFunction({ name, data }) → 事件云函数（不直连 PG/AI）
  ├─ 照片: FileReader → base64 → photos.create（不经云存储）
  └─ window.APP_CONFIG.envId（部署前填入）
        │
事件云函数 (CommonJS, Nodejs18.15)
  ├─ _shared/db.js (pg.Pool 读 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD/TCB_ENV)
  │    └─ 参数化 SQL（$1,$2,...），空串 → null
  └─ @cloudbase/node-sdk
       └─ app.ai().createModel('cloudbase').generateText({ model: 'hy3' })
```

**边界**：前端不直连 PG，不直连 AI。所有 PG 访问与 AI 调用都在云函数内完成。
照片 base64 存 `photos` 表（`photo_url` = data URL），不调多模态，不开云存储匿名登录。
不启用 VPC，不填 VPC ID / 子网。

## 8 个事件云函数

| 云函数 | 超时 | 说明 |
|--------|------|------|
| `customers` | 10s | 客户 CRUD（list/get/create/update/remove） |
| `followups` | 10s | 跟进记录 CRUD |
| `products` | 10s | 保险额度 upsert（每客户一行，10 个 ap_* bigint） |
| `gifts` | 10s | 伴手礼 CRUD |
| `photos` | 10s | 照片存储（base64 → photos 表，list 只返元数据，get 返 data URL） |
| `ai_recommendations` | 10s | AI 建议历史列表（只读） |
| `ai_parse` | **120s** | AI 文本解析 → 客户资料（hy3），可选存图 |
| `ai_recommend` | **120s** | AI 跟进建议生成（hy3）→ 写 ai_recommendations |

详细契约见 `README.md`。

## 硬约束

1. **AI 只用 hy3**：`app.ai().createModel('cloudbase')` + `generateText({ model: 'hy3' })`。
2. **禁止第三方 Key**：无 deepseek/openai/任何外部 AI Key；禁止前端直连外部 AI。
3. **PG 凭证只在云函数环境变量**（不入仓库、不落前端）：
   - `PGHOST`（内网地址）/ `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` / `TCB_ENV` / `AI_MODEL=hy3`
4. **照片 base64 存 `photos` 表**，不调多模态，不开云存储匿名登录。
5. **所有 SQL 参数化**：`$1, $2, ...`，空串统一转 null。
6. **不启用 VPC**：共享集群 PG，`ssl=false`，云函数直连内网地址。
7. **admin.html `apiBase` 留空**：通过 `callFunction` 同域调用。

## 数据表（6 张，已存在且有真实数据）

> 表已建好，以下为实际 schema（从 PG 查询得到）。主键生成方式已确认。

### `customers`（761 行，中心表）
- **主键**：`Id`（大写 I，integer，**IDENTITY BY DEFAULT**，INSERT 可省略）
- 列：`Id`, `customer_name`(text,NOT NULL), `gender`, `phone`, `birthday`(date), `source`, `tags`, `hobbies`, `occupation`, `marital_status`, `properties_info`, `annual_income`(int), `household_income`, `customer_stage`(enum `客户经营阶段`), `sales_priority`(enum `优先级`), `recruitment_priority`(enum), `referral_priority`(enum), `additional_info`, `first_contact_date`(date), `deleted_at`(timestamp,软删除), `created_at`(默认 now), `updated_at`(无默认,手动写)

### `followups`（220 行）
- **主键**：`Id`（大写 I，integer，IDENTITY BY DEFAULT）
- 列：`Id`, `customer_id`(int,NOT NULL), `customer_name`(text,NOT NULL), `followup_notes`, `followup_date`(date), `next_followup_date`(date), `next_followup_goal`(enum `跟进目标`), `created_at`(**无默认,手动写**), `updated_at`(**无默认,手动写**)

### `ai_recommendations`（11 行）
- **主键**：`id`（小写，bigint，IDENTITY BY DEFAULT）
- 列：`id`, `customer_id`(int,NOT NULL), `customer_name`(text,NOT NULL), `recommendation_date`(date,NOT NULL), `suggested_followup_date`(date), `suggested_message`, `suggested_strategy`, `suggested_customer_stage`(enum), `suggested_followup_goal`(enum), `created_at`(默认 now)

### `products`（0 行）
- **主键**：`id`（小写，bigint，IDENTITY BY DEFAULT）
- 列：`id`, `customer_id`(bigint), `customer_name`(text,NOT NULL), `created_at`(默认 now), `ap_ipa`/`ap_ltc`/`ap_ann`/`ap_life`/`ap_term`/`ap_wl`/`ap_pa`/`ap_ci`/`ap_hi`/`ap_all`（均 bigint）

### `gifts`（188 行）
- **主键**：`Id`（大写 I，bigint，IDENTITY BY DEFAULT）
- 列：`Id`, `customer_id`(int,NOT NULL), `customer_name`(text,NOT NULL), `gift_name`(text,NOT NULL), `quantity`(smallint), `notes`, `given_date`(date), `created_at`(默认 now)

### `photos`（0 行）
- **主键**：`id`（小写，integer，**无序列 / 非 identity → 手动分配 MAX(id)+1**）
- 列：`id`, `customer_id`(int,NOT NULL), `customer_name`(text,NOT NULL), `photo_url`(text,NOT NULL,存 data URL), `thumbnail_url`, `file_name`, `content_type`, `sort_order`(默认0), `created_at`(默认 now)

### 枚举类型（中文命名）
- `客户经营阶段`：新认识 / 关系维护 / 需求挖掘 / 方案沟通 / 成交推进 / 转介绍经营
- `优先级`：A / B / C / D / E
- `跟进目标`：建立联系 / 约见面 / 邀请活动 / 获取家庭信息 / 推进签单 / 推进招募 / 推进转介绍

### RLS 状态
所有 6 张表 RLS 已启用但无 policy → 不影响（云函数用 `pg` 包 + PG 凭证 admin 直连，绕过 RLS）。

## 部署清单（待人工配 PG_* 后执行）

- [ ] 控制台为每个云函数注入环境变量：`PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD`/`TCB_ENV`/`AI_MODEL=hy3`
- [ ] 打包 `_shared/db.js` 到各函数目录（`cp` + 改 require，或 esbuild 内联）
- [ ] 部署 8 个云函数（ai_parse/ai_recommend timeout=120s，其余 10s）
- [ ] 部署 `admin.html` 到静态托管，填入 `envId`
- [ ] 开通匿名登录（身份验证设置，**非**云存储匿名登录）供 callFunction
- [ ] 端到端验证

## 禁止

- 前端出现 `PGPASSWORD` / 任何 PG 凭证
- 前端 `fetch('https://api.openai.com/...')` 或任何第三方 AI 端点
- 字符串拼接 SQL
- 照片 OCR / 图像识别 / 多模态调用
- `createModel('deepseek')` / `createModel('openai')` 等 vendor 名
- 启用 VPC
