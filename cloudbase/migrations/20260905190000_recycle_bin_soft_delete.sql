-- ============================================================
-- 回收站功能：子表软删除列 + 增员回收站视图
-- 规则:
--   1. 应用内直接删除子记录(跟进/礼品/照片/报告/AI解析记录/产品额度/增员跟进)
--      = 硬删除(各云函数 remove 保持 DELETE 不变, 不进回收站)
--   2. 删除客户/增员候选人(主对象) = 级联软删除
--      (打 deleted_at 标记, 关联子记录一并标记, 可从回收站恢复)
-- 内容:
--   1. 7 张子表增加 deleted_at timestamptz(幂等)
--   2. 新建视图 v_recruit_candidates_trash(增员回收站列表用, JOIN customers)
-- ============================================================

ALTER TABLE public.followups              ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.gifts                  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.photos                 ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.policy_review_reports  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.ocr_records            ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.products               ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.recruit_followups      ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

DROP VIEW IF EXISTS public.v_recruit_candidates_trash;

CREATE VIEW public.v_recruit_candidates_trash AS
SELECT rc.id            AS candidate_id,
       rc.customer_id,
       c.customer_name,
       c.phone,
       c.occupation,
       rc.stage,
       rc.operator,
       rc.created_at,
       rc.updated_at,
       rc.deleted_at    AS candidate_deleted_at,
       c.deleted_at     AS customer_deleted_at
FROM public.recruit_candidates rc
JOIN public.customers c ON c."Id" = rc.customer_id
WHERE rc.deleted_at IS NOT NULL;

COMMENT ON VIEW public.v_recruit_candidates_trash IS '增员回收站视图（软删除候选人+客户基础信息；customer_deleted_at 用于"随客户删除"标识）';

GRANT SELECT ON public.v_recruit_candidates_trash TO anon, authenticated, service_role;
