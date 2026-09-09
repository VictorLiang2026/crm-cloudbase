-- Victor's CRM v1.8 Sprint 1：客户/跟进/机会/增员候选人「下一步行动」基础数据能力
-- 幂等（IF NOT EXISTS）、可重复执行、不影响已有数据、不改类型/主键/外键/RLS、不删除任何字段和数据
-- opportunities.next_action、recruit_candidates.next_action/next_action_date 已存在，自动跳过

-- customers：下一步行动
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS next_action_date DATE;

-- followups：互动摘要 + 下一步行动
ALTER TABLE public.followups ADD COLUMN IF NOT EXISTS interaction_summary TEXT;
ALTER TABLE public.followups ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE public.followups ADD COLUMN IF NOT EXISTS next_action_date DATE;

-- opportunities：补下一步行动日期（next_action 已存在）
ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS next_action_date DATE;

-- recruit_followups：互动摘要 + 下一步行动
ALTER TABLE public.recruit_followups ADD COLUMN IF NOT EXISTS interaction_summary TEXT;
ALTER TABLE public.recruit_followups ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE public.recruit_followups ADD COLUMN IF NOT EXISTS next_action_date DATE;
