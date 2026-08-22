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
│   ├── _shared/db.js              # 共享：rdb() 数据访问 + AI(hy3) 封装（部署时复制为各函数 ./db.js）
│   ├── customers/                 # 客户 CRUD
│   ├── followups/                 # 跟进记录 CRUD
│   ├── products/                  # 保险额度 upsert（每客户一行）
│   ├── gifts/                     # 伴手礼 CRUD
│   ├── photos/                    # 照片存储（base64 → photos 表）
│   ├── ai_recommendations/        # AI 建议历史列表（只读）
│   ├── ai_parse/                  # AI 文本解析 → 客户资料（hy3，120s）
│   └── ai_recommend/              # AI 跟进建议生成（hy3，120s）
├── admin.html                     # 单页管理台（callFunction 同域）
├── .env.example                   # 环境变量占位
└── README.md                      # 本文件
```

## 云函数超时配置

| 云函数 | 超时 | 说明 |
|--------|------|------|
| customers / followups / products / gifts / photos / ai_recommendations | 10s | 常规 CRUD |
| ai_parse | 120s | 调 hy3 解析文本 |
| ai_recommend | 120s | 调 hy3 生成建议 |

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

## 枚举值（PG 自定义类型）

- `客户经营阶段`：新认识 / 关系维护 / 需求挖掘 / 方案沟通 / 成交推进 / 转介绍经营
- `优先级`：A / B / C / D / E
- `跟进目标`：建立联系 / 约见面 / 邀请活动 / 获取家庭信息 / 推进签单 / 推进招募 / 推进转介绍

## 前端（admin.html）

- 单页 HTML，无构建步骤
- `@cloudbase/js-sdk` CDN：`https://static.cloudbase.net/cloudbase-js-sdk/latest/cloudbase.full.js`
- `window.APP_CONFIG.envId` 填环境 ID（部署前修改）
- `apiBase` 留空：通过 `app.callFunction({ name, data })` 同域调用，不直连 PG/AI
- **用户名密码登录**（`auth.signInWithPassword`）：PG 模式下云函数 HTTP API 对匿名用户默认不放行（`EXCEED_AUTHORITY`），必须用注册用户登录后调用 callFunction；登录态由 SDK 本地持久化
- 照片上传：FileReader → base64 → `photos.create`；显示：`photos.get` 懒加载 data URL

## 数据库安全（RLS）

共享集群 PG 的 REST API（`https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/...`）默认对匿名 token（`role=anon`）开放，且云函数 `app.rdb()` 的实际身份也是 `anon`。为防止任何人匿名 REST 直读客户数据，6 张业务表（customers / followups / products / gifts / photos / ai_recommendations）均启用 RLS，policy 统一为：

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

1. **配置环境变量**：在 CloudBase 控制台为每个云函数注入 `TCB_ENV`（环境 ID）和 `AI_MODEL=hy3`（仅 ai_parse / ai_recommend 需要）。**不需要任何 PG_* 变量**（共享集群无 PG 协议直连）。
2. **打包共享模块**：将 `_shared/db.js` 复制到每个云函数目录（源码已直接 `require('./db')`）：
   ```bash
   for d in customers followups products gifts photos ai_recommendations ai_parse ai_recommend; do
     cp cloudfunctions/_shared/db.js "cloudfunctions/$d/db.js"
   done
   ```
   （本项目另有 `.deploy/<func>/` 目录为最终部署产物，与 `cloudfunctions/` 源码保持一致）
3. **部署云函数**：`tcb fn deploy <name>` 或控制台上传各目录（超时：ai_parse/ai_recommend 120s，其余 10s；依赖 `@cloudbase/node-sdk@^4.0.3` 云端安装）
4. **部署前端**：`tcb hosting deploy admin.html`（或控制台静态托管上传 `admin.html`，并填入 `envId`）
5. **创建登录用户**：`managePermissions(action="createUser", username=..., password=...)` 或控制台「身份认证 → 用户管理」创建（PG 模式 HTTP API 不支持纯用户名密码自助注册）。当前账号：`crm_admin`
6. **网关 OPA 策略**（已配置）：`authz.user.rego` 显式 `deny` 匿名/未登录用户调用 functions（纵深防御；注册用户由平台默认策略放行）
7. **端到端验证**：打开 admin.html → 登录 → 列表加载 → 新增客户 → 详情各页签 → AI 解析/建议

## 硬性限制

- AI 仅 hy3，`app.ai().createModel('cloudbase')`，`AI_MODEL=hy3`
- 禁止 deepseek / openai / 任何第三方 Key
- 禁止前端直连 PG 或 AI
- 数据访问仅 `app.rdb()`（node-sdk 4.x），无 PG 凭证、无 VPC
- 6 张业务表 RLS policy 仅放行云函数 token（无 `sub`），不得建 `TO anon USING (true)` 类过宽 policy，不得对 anon 授予 `*_view` 视图 SELECT
- 照片 base64 存 `photos` 表，不调多模态，不开云存储匿名登录
- 不启用 VPC
