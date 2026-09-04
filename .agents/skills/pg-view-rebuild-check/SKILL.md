---
name: "pg-view-rebuild-check"
description: "PostgreSQL 基表加列/改列后检查并重建依赖视图的清单。Invoke when 编写或执行 ALTER TABLE 迁移、表上存在视图（本项目列表/详情查询均走 v_* 视图），或用户反馈字段保存成功但页面不显示/读不到数据。"
---

# PG 视图随表结构变更重建检查清单

## 核心原理（必须记住）

- PostgreSQL 视图在 **CREATE 时绑定列清单**：即使定义里写 `SELECT *`，也会在创建瞬间展开为当时的列。之后 `ALTER TABLE ADD COLUMN` **不会**反映到已有视图。
- 本项目所有列表/详情查询都走视图（云函数 `rdb.from('v_xxx').select('*')`，如 `v_recruit_candidates`）。视图缺列是**静默故障**：写入成功、`SELECT *` 不报错，但前端拿到的字段永远是 `undefined`，表现为"保存成功但页面不显示/永远显示未上传"。若 `ORDER BY` 的列在视图中缺失，则会直接报 SQL 错误（页面整体打不开）。
- `CREATE OR REPLACE VIEW` 只能在**末尾追加**新列，不能删列、改列序或改列类型。补列/删列场景一律用 `DROP VIEW` + `CREATE VIEW` 最稳妥。
- **`DROP VIEW` 会连带删除该视图上的所有 GRANT 授权**，重建后必须重新授权。

## 触发时机

1. 编写/执行任何 `ALTER TABLE ... ADD/DROP/RENAME COLUMN` 迁移时，**同一迁移或紧跟的迁移中**必须处理视图。
2. 排查"字段写库成功（update 返回 ok）但前端读不到/不回显"类问题时，第一嫌疑就是视图未重建。

## 执行步骤

### 1. 找出依赖该表的所有视图

```sql
SELECT viewname, definition
FROM pg_views
WHERE schemaname = 'public'
  AND definition ILIKE '%recruit_candidates%';  -- 替换为目标基表名
```

### 2. 对比基表与视图的列差异

```sql
-- 基表列
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='recruit_candidates'
ORDER BY ordinal_position;

-- 视图列
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='v_recruit_candidates'
ORDER BY ordinal_position;
```

基表有、视图没有的列 = 必须补进视图。

### 3. DROP 前检查是否有其他对象依赖该视图

```sql
SELECT dep.objid::regclass AS dependent_object, dep.deptype
FROM pg_depend dep
JOIN pg_rewrite rw ON rw.oid = dep.objid
JOIN pg_class v ON v.oid = rw.ev_class
WHERE v.relname = 'v_recruit_candidates';
-- 若有其他视图/函数依赖，需先处理上层对象，或用 DROP VIEW ... CASCADE 并全部重建
```

### 4. 写迁移：DROP + CREATE + GRANT 三件套

迁移文件放 `cloudbase/migrations/<14位时间戳>_<name>.sql`，模板：

```sql
DROP VIEW IF EXISTS public.v_xxx;

CREATE VIEW public.v_xxx AS
SELECT rc.id AS candidate_id, ..., rc.new_col,   -- 新列显式列出
       rc.created_at, rc.updated_at
FROM public.base_table rc
JOIN ... 
WHERE rc.deleted_at IS NULL ...;

COMMENT ON VIEW public.v_xxx IS '...';

-- 关键：DROP 后授权丢失，必须重新授予
GRANT SELECT ON public.v_xxx TO anon, authenticated, service_role;
```

新列加在视图 SELECT 列清单中（位置建议与基表逻辑一致，云函数 `select('*')` 按名取值不依赖顺序，但保持可读）。

### 5. 通过 MCP 应用迁移

- 用 `managePgDatabase(action="applyMigration", migrationName, migrationVersion=<14位>, confirm=true)`。
- migrationVersion 必须大于远端 `listMigrations` 的 LatestVersion；禁止由系统静默生成。
- MCP 可能把本地 SQL 副本写到 `C:\Users\victor\cloudbase\migrations\`（MCP 工作目录），**项目仓库 `cloudbase/migrations/` 也要有同名文件并提交 Git**，两份内容保持一致。
- 环境未绑定时会报 `ENV_REQUIRED`：先 `auth(action="set_env", envId="crm-d1gkae8ddc930d151")`。

### 6. 双重验证

1. SQL 层：查 `information_schema.columns` 确认新列出现在视图中。
2. **端到端（必做）**：用 `manageFunctions(action="invokeFunction")` 调对应云函数的 `list`/`get`，确认返回 JSON 中含新字段；有条件可 create → update 新字段 → get 回读 → remove 清理，走完整闭环。
3. 不要只查 `storage.buckets`/RLS 策略——那是云存储权限（`storage.objects` 上的 policy），与表视图无关，别混淆。

## 本项目注意事项

- **MCP SQL 工具默认只返回 20 行**（`truncated:false` 也可能截断目录查询结果）。查 `pg_attribute`、`information_schema.columns`、`pg_views` 等目录视图时**必须传 `limit` 参数（如 100）**，否则会误判"列不存在"。
- 视图命名约定：`v_<基表名>`；云函数中 `rdb.from('v_...')` 只读，写操作直接对基表。
- 涉及 GRANT 的迁移同时覆盖 `anon, authenticated, service_role` 三个角色。
- 迁移成功后提交 Git 并推送（"提交即推"工作流），重新生成 `backups/*.bundle` 完整备份。

## 历史案例

- 20260905120000 `recruit_files`：给 `recruit_candidates` 加雷达图/报告 4 个附件列，未重建视图 → 前端"评估附件"区始终显示未上传。20260905130000 `recruit_view_files` DROP 重建视图补齐 4 列并重新 GRANT 后修复。
- 排查弯路：information_schema 默认 20 行截断曾造成"列丢失"假象；确认表真实结构用 `pg_attribute`（带 limit）或 `pg_views.definition` 最可靠。
