-- followups 新增 recommendation_id 列，关联 ai_recommendations.Id
-- 用于 NBA → 沟通记录闭环：记录本次沟通对应哪条 AI 经营建议
-- 不建外键约束（轻量），不建新表

ALTER TABLE followups ADD COLUMN IF NOT EXISTS recommendation_id integer;

-- 重建 followups 视图（如果有）
-- followups 无独立视图，跳过

GRANT SELECT, INSERT, UPDATE, DELETE ON followups TO authenticated, service_role, cloudbase_postgres_pgdb_pn3idppt;
