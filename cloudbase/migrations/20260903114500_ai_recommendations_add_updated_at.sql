-- 20260903114500_ai_recommendations_add_updated_at
-- 为 ai_recommendations 增加 updated_at 列（记录人工编辑时间/二次生成时间）。
-- 此前「保单检视升级」新功能在 ai_recommendations/update 中写入了 payload.updated_at，
-- 但原表 schema 只有 created_at，导致「permission / column not found」级报错。
ALTER TABLE ai_recommendations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
COMMENT ON COLUMN ai_recommendations.updated_at IS '人工编辑时间或二次生成时间';
-- 对已存在的旧行，用 updated_at = created_at 对齐（DEFAULT now() 会全部变当前时间，这里补一次历史回填以保证语义）。
UPDATE ai_recommendations SET updated_at = created_at WHERE created_at IS NOT NULL;
