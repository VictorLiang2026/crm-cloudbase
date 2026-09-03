-- 20260905100000: 增员表结构重构 — 去重叠字段，客户表补通用字段，建视图
-- 设计原则：增员对象一定是客户对象，客户对象不一定是增员对象
--   重复字段归 customers；recruit_candidates 只保留增员专属字段
--   customer_id 改为 NOT NULL（强约束：增员必须先有客户记录）

-- 1. customers 补通用字段
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS education text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS mbti text;
COMMENT ON COLUMN public.customers.education IS '学历';
COMMENT ON COLUMN public.customers.mbti IS 'MBTI 16型人格';

-- 2. recruit_candidates 删重叠字段 + 新增专属字段
ALTER TABLE public.recruit_candidates ALTER COLUMN customer_id SET NOT NULL;
ALTER TABLE public.recruit_candidates DROP COLUMN IF EXISTS name;
ALTER TABLE public.recruit_candidates DROP COLUMN IF EXISTS gender;
ALTER TABLE public.recruit_candidates DROP COLUMN IF EXISTS birthday;
ALTER TABLE public.recruit_candidates DROP COLUMN IF EXISTS phone;
ALTER TABLE public.recruit_candidates DROP COLUMN IF EXISTS wechat;
ALTER TABLE public.recruit_candidates DROP COLUMN IF EXISTS occupation;
ALTER TABLE public.recruit_candidates DROP COLUMN IF EXISTS annual_income;
ALTER TABLE public.recruit_candidates DROP COLUMN IF EXISTS source;
ALTER TABLE public.recruit_candidates DROP COLUMN IF EXISTS notes;
ALTER TABLE public.recruit_candidates ADD COLUMN IF NOT EXISTS work_experience   text;
ALTER TABLE public.recruit_candidates ADD COLUMN IF NOT EXISTS family_situation  text;
ALTER TABLE public.recruit_candidates ADD COLUMN IF NOT EXISTS personality_tags  text;
ALTER TABLE public.recruit_candidates ADD COLUMN IF NOT EXISTS career_plan       text;
ALTER TABLE public.recruit_candidates ADD COLUMN IF NOT EXISTS next_action_date  date;
ALTER TABLE public.recruit_candidates ADD COLUMN IF NOT EXISTS next_action       text;
ALTER TABLE public.recruit_candidates ADD COLUMN IF NOT EXISTS activity_history  jsonb;

-- 3. 视图
CREATE OR REPLACE VIEW public.v_recruit_candidates AS
SELECT rc.id AS candidate_id, rc.customer_id, c.customer_name, c.gender, c.birthday, c.phone, c.wx_account, c.occupation, c.annual_income, c.education, c.mbti, c.source, c.marital_status, c.hobbies, c.additional_info, rc.recommender_id, rc.stage, rc.stage_changed_at, rc.potential_score, rc.potential_reason, rc.motivation, rc.concerns, rc.work_experience, rc.family_situation, rc.personality_tags, rc.career_plan, rc.next_action_date, rc.next_action, rc.activity_history, rc.operator, rc.created_at, rc.updated_at, CASE WHEN rc.stage_changed_at IS NOT NULL THEN EXTRACT(DAY FROM now() - rc.stage_changed_at)::integer ELSE NULL END AS idle_days
FROM public.recruit_candidates rc JOIN public.customers c ON c."Id" = rc.customer_id WHERE rc.deleted_at IS NULL AND c.deleted_at IS NULL;
COMMENT ON VIEW public.v_recruit_candidates IS '增员候选人完整视图';

-- 4. 权限
GRANT SELECT ON public.v_recruit_candidates TO anon, authenticated, service_role;
GRANT UPDATE (education, mbti) ON public.customers TO anon, authenticated, service_role;
GRANT UPDATE (work_experience, family_situation, personality_tags, career_plan, next_action_date, next_action, activity_history) ON public.recruit_candidates TO anon, authenticated, service_role;
