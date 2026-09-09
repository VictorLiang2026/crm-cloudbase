-- Victor's CRM v1.8 Sprint 8：轻量漏斗统计视图（纯只读，不建任何业务表）
-- 三条漏斗：客户经营 customers.customer_stage / 经营机会 opportunities.status / 组织发展 recruit_candidates.stage
-- 原则：SQL 只负责事实（当前人数/各阶段数量/近期进入/阶段推进/逾期/停留），不产出转化率等比率指标；
--       样本是否足够、要不要展示比率，由云函数按样本量决定（小样本不输出无意义统计）。
-- 事实口径：
--   current_count      各阶段当前人数（软删除排除；客户 NULL 阶段归一为「未分层」）
--   entered_30d        近 30 天进入漏斗（客户 created_at / 机会 discovered_at 回退 created_at / 候选人 created_at）
--   moved_30d          近 30 天发生阶段推进的人数（仅增员有 stage_changed_at，且排除窗口期内新建者；
--                      客户/机会无阶段变更时间戳，恒为 NULL = 信息不足，不推断）
--   overdue_count      该阶段当前存在逾期行动的人数（复用 v_action_center status='overdue'，与今日经营同口径）
--   dwell_median_days  当前阶段停留中位数（增员=stage_changed_at；机会=发现以来且仅非终态；客户恒 NULL）
--   stuck_count        停留偏久人数（增员>30 天且非终态；机会发现>60 天且未关闭；客户恒 NULL）
-- 幂等：DROP IF EXISTS + CREATE，可重复执行

DROP VIEW IF EXISTS public.v_funnel_stats;

CREATE VIEW public.v_funnel_stats AS
WITH dim AS (
    -- 客户：enum「客户经营阶段」全量枚举，顺序按 enumsortorder；0 位给「未分层」
    SELECT 'customer'::text AS funnel,
           e.enumlabel::text AS stage,
           e.enumsortorder::int AS stage_order,
           'active'::text AS kind
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = '客户经营阶段'
    UNION ALL
    SELECT 'customer'::text, '未分层'::text, 0, 'unclassified'::text
    UNION ALL
    -- 机会：与前端 OPP_STATUSES 一致（转介绍线索 REF 状态若出现，走 other 扩展行）
    SELECT * FROM (VALUES
        ('opportunity'::text, '发现'::text, 1::int, 'active'::text),
        ('opportunity', '沟通', 2, 'active'),
        ('opportunity', '方案', 3, 'active'),
        ('opportunity', '成交', 4, 'terminal'),
        ('opportunity', '关闭', 5, 'terminal')
    ) vopp(funnel, stage, stage_order, kind)
    UNION ALL
    -- 增员：与前端 RC_STAGES 一致（历史「流失」若出现，走 other 扩展行）
    SELECT * FROM (VALUES
        ('recruit'::text, '新增人才'::text, 1::int, 'active'::text),
        ('recruit', '互动暖客', 2, 'active'),
        ('recruit', '初次面谈', 3, 'active'),
        ('recruit', '增员活动', 4, 'active'),
        ('recruit', '精准面谈', 5, 'active'),
        ('recruit', '入职申请', 6, 'active'),
        ('recruit', '签约入司', 7, 'terminal')
    ) vrc(funnel, stage, stage_order, kind)
),
fact AS (
    -- 客户：无阶段变更时间戳 → moved_30d / dwell / stuck 恒 NULL（信息不足，不臆造）
    SELECT 'customer'::text AS funnel,
           COALESCE(c.customer_stage::text, '未分层') AS stage,
           count(*) AS current_count,
           count(*) FILTER (WHERE c.created_at >= now() - interval '30 days') AS entered_30d,
           NULL::bigint AS moved_30d,
           count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM public.v_action_center a
               WHERE a.person_type = 'customer'
                 AND a.person_id = c."Id"
                 AND a.status = 'overdue')) AS overdue_count,
           NULL::int AS dwell_median_days,
           NULL::bigint AS stuck_count
    FROM public.customers c
    WHERE c.deleted_at IS NULL
    GROUP BY COALESCE(c.customer_stage::text, '未分层')

    UNION ALL
    -- 机会：无状态变更时间戳，停留以「发现以来」计（discovered_at 空回退 created_at），仅非终态
    SELECT 'opportunity'::text,
           o.status,
           count(*),
           count(*) FILTER (WHERE COALESCE(o.discovered_at, o.created_at::date) >= CURRENT_DATE - 30),
           NULL::bigint,
           count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM public.v_action_center a
               WHERE a.action_type = 'opportunity'
                 AND a.person_id = o.id
                 AND a.status = 'overdue')),
           (percentile_cont(0.5) WITHIN GROUP (
               ORDER BY CURRENT_DATE - COALESCE(o.discovered_at, o.created_at::date))
               FILTER (WHERE o.status NOT IN ('成交', '关闭')))::int,
           count(*) FILTER (WHERE o.status NOT IN ('成交', '关闭')
               AND CURRENT_DATE - COALESCE(o.discovered_at, o.created_at::date) >= 60)
    FROM public.opportunities o
    WHERE o.deleted_at IS NULL
    GROUP BY o.status

    UNION ALL
    -- 增员：唯一有 stage_changed_at 的漏斗，阶段推进/停留为真实口径
    SELECT 'recruit'::text,
           rc.stage,
           count(*),
           count(*) FILTER (WHERE rc.created_at >= now() - interval '30 days'),
           count(*) FILTER (WHERE rc.stage_changed_at >= now() - interval '30 days'
                            AND rc.created_at < now() - interval '30 days'),
           count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM public.v_action_center a
               WHERE a.person_type = 'recruit'
                 AND a.person_id = rc.id
                 AND a.status = 'overdue')),
           (percentile_cont(0.5) WITHIN GROUP (
               ORDER BY CURRENT_DATE - rc.stage_changed_at::date)
               FILTER (WHERE rc.stage <> '签约入司' AND rc.stage_changed_at IS NOT NULL))::int,
           count(*) FILTER (WHERE rc.stage NOT IN ('签约入司', '流失')
               AND CURRENT_DATE - rc.stage_changed_at::date >= 30)
    FROM public.recruit_candidates rc
    WHERE rc.deleted_at IS NULL
    GROUP BY rc.stage
),
-- 维度外实际出现的阶段（如转介绍 REF 状态、历史「流失」）：扩展行，排在后面
extra AS (
    SELECT f.funnel,
           f.stage,
           (90 + row_number() OVER (PARTITION BY f.funnel ORDER BY f.stage))::int AS stage_order,
           CASE WHEN f.stage IN ('流失', '关闭', '成交')
                THEN 'terminal'::text ELSE 'other'::text END AS kind,
           f.current_count,
           f.entered_30d,
           f.moved_30d,
           f.overdue_count,
           f.dwell_median_days,
           f.stuck_count
    FROM fact f
    WHERE NOT EXISTS (
        SELECT 1 FROM dim d WHERE d.funnel = f.funnel AND d.stage = f.stage)
)
SELECT d.funnel,
       d.stage,
       d.stage_order,
       d.kind,
       COALESCE(f.current_count, 0) AS current_count,
       COALESCE(f.entered_30d, 0) AS entered_30d,
       f.moved_30d,
       COALESCE(f.overdue_count, 0) AS overdue_count,
       f.dwell_median_days,
       f.stuck_count
FROM dim d
LEFT JOIN fact f ON f.funnel = d.funnel AND f.stage = d.stage
UNION ALL
SELECT e.funnel, e.stage, e.stage_order, e.kind,
       e.current_count, e.entered_30d, e.moved_30d, e.overdue_count,
       e.dwell_median_days, e.stuck_count
FROM extra e
ORDER BY funnel, stage_order;

COMMENT ON VIEW public.v_funnel_stats IS 'v1.8 Sprint 8 轻量漏斗事实视图：客户/机会/增员三漏斗各阶段当前人数、近30天进入、阶段推进(仅增员)、逾期行动(复用v_action_center)、停留中位数与停留偏久人数；纯 SQL 事实，不含比率，小样本保护由云函数负责';

GRANT SELECT ON public.v_funnel_stats TO anon, authenticated, service_role;
