-- 20260908100000: 增员候选人画像 jsonb（v1.5）
-- 复用客户 profile 设计思想：recruit_candidates 加 profile jsonb 列
-- 视图 v_recruit_candidates 与 GRANT 由部署脚本通过 executePGSql 同步更新
ALTER TABLE public.recruit_candidates ADD COLUMN IF NOT EXISTS profile jsonb;
COMMENT ON COLUMN public.recruit_candidates.profile IS '增员候选人画像（AI 提取，用户确认后写入）';
