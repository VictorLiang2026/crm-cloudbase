-- ============================================================
-- 增员相关表安全基线对齐（对齐 customers 基线）
-- 内容:
--   1. GRANT 对齐: 补齐 recruit_goal_benchmarks anon 的 INSERT/DELETE;
--      收回 recruit_candidates / recruit_milestones anon 超基线的 TRUNCATE
--   2. RLS 对齐: 5 张增员表 ENABLE ROW LEVEL SECURITY +
--      fn_only 策略(仅云函数匿名上下文可访问, 与 customers_fn_only 逐字一致)
-- 目的: 平台若收紧默认权限, 增员数据访问行为与客户表一致, 不会被锁死
-- ============================================================

-- ===== 1. GRANT 对齐 =====
GRANT INSERT, DELETE ON public.recruit_goal_benchmarks TO anon;

REVOKE TRUNCATE ON public.recruit_candidates FROM anon;
REVOKE TRUNCATE ON public.recruit_milestones FROM anon;

-- ===== 2. RLS 启用 =====
ALTER TABLE public.recruit_candidates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruit_milestones      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruit_followups       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruit_goals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruit_goal_benchmarks ENABLE ROW LEVEL SECURITY;

-- ===== 3. fn_only 策略(与 customers_fn_only 同款) =====
CREATE POLICY recruit_candidates_fn_only ON public.recruit_candidates
  FOR ALL TO anon
  USING ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text))
  WITH CHECK ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text));

CREATE POLICY recruit_milestones_fn_only ON public.recruit_milestones
  FOR ALL TO anon
  USING ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text))
  WITH CHECK ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text));

CREATE POLICY recruit_followups_fn_only ON public.recruit_followups
  FOR ALL TO anon
  USING ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text))
  WITH CHECK ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text));

CREATE POLICY recruit_goals_fn_only ON public.recruit_goals
  FOR ALL TO anon
  USING ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text))
  WITH CHECK ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text));

CREATE POLICY recruit_goal_benchmarks_fn_only ON public.recruit_goal_benchmarks
  FOR ALL TO anon
  USING ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text))
  WITH CHECK ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text));
