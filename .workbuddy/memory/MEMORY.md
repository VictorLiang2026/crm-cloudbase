# MEMORY

## 项目约定（个人 CRM · CloudBase 个人版 crm-d1gkae8ddc930d151）

- 环境：`crm-d1gkae8ddc930d151`（alias crm，上海，PG 共享集群 pgdb-pn3idppt，TenantType SHARED，**无 PG 直连凭证**）
- 数据访问：云函数内 `@cloudbase/node-sdk@^4` 的 `app.rdb()`（免密）；AI 仅 hy3（`app.ai().createModel('cloudbase')`）；禁第三方 Key；不开 VPC；照片 base64 存 photos 表
- 前端 admin.html 只走 `app.callFunction` 同域调用；**登录方式是用户名密码**（`signInWithPassword`，账号 crm_admin），**不能用匿名登录**——PG 模式云函数 HTTP API 对匿名默认 EXCEED_AUTHORITY，且角色策略控制台/API 在 PG 环境不可配
- 网关 OPA 策略（authz.user.rego）已设 deny 匿名调 functions；改动用 `managePermissions setPolicy`（Rego v1 语法，package authz.user）
- **数据库安全基线**（2026-08-19 建立，不得回退）：
  - 6 张业务表 RLS policy `<t>_fn_only TO anon FOR ALL`，条件 `claims->>'sub' IS NULL AND claims->>'role'='anon'`（云函数 token 无 sub，用户 token 必有 sub）
  - 禁止 `TO anon USING(true)` 类过宽 policy；禁止对 anon GRANT `*_view` 视图（视图绕过表 RLS）
  - identity 序列名是中文旧表名（客户列表_Id_seq 等）；批量导入后需 setval 到 max+1
- 部署产物：`.deploy/<func>/`（index.js + db.js + package.json，node-sdk ^4.0.3）；源码 `cloudfunctions/`
- 详见 `memory/2026-08-19.md`
