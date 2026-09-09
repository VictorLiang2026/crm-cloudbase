-- Victor's CRM v1.8 Sprint 2：Action Center 统一行动中心视图
-- 纯视图（只读）：不建业务表、不改业务表逻辑、不删除/修改现有视图、不改云函数与前端
-- 基础事实全部由 SQL 计算（是否逾期/今天/未来/未排期、距今天数、最近一次跟进），AI 不参与
-- 数据源：customers / followups / opportunities / recruit_candidates / recruit_followups / activity_tasks
-- 幂等：DROP IF EXISTS + CREATE，可重复执行

DROP VIEW IF EXISTS public.v_action_center;

CREATE VIEW public.v_action_center AS
SELECT
    v.action_id,
    v.action_type,
    v.person_type,
    v.person_id,
    v.person_name,
    v.title,
    v.next_action,
    v.action_date,
    v.priority,
    v.source,
    -- 状态：纯 SQL 基于 action_date 与 CURRENT_DATE（PG 时区 PRC = 北京时间）
    CASE
        WHEN v.action_date IS NULL THEN 'unscheduled'
        WHEN v.action_date < CURRENT_DATE THEN 'overdue'
        WHEN v.action_date = CURRENT_DATE THEN 'today'
        WHEN v.action_date > CURRENT_DATE THEN 'upcoming'
    END AS status,
    v.stage,
    v.days_until,
    v.last_followup_date
FROM (
    -- 1) 客户行动：客户档案上的下一步行动（Sprint 1 baseline 列）
    SELECT
        ('customer-' || c."Id")                          AS action_id,
        'customer'::text                                 AS action_type,
        'customer'::text                                 AS person_type,
        c."Id"::bigint                                   AS person_id,
        c.customer_name                                  AS person_name,
        ('客户经营 · ' || c.customer_name)               AS title,
        NULLIF(btrim(c.next_action), '')                 AS next_action,
        c.next_action_date                               AS action_date,
        c.sales_priority::text                           AS priority,
        'customers'::text                                AS source,
        c.customer_stage::text                           AS stage,
        (c.next_action_date - CURRENT_DATE)              AS days_until,
        (SELECT max(f.followup_date) FROM public.followups f
          WHERE f.customer_id = c."Id" AND f.deleted_at IS NULL) AS last_followup_date
    FROM public.customers c
    WHERE c.deleted_at IS NULL
      AND (NULLIF(btrim(c.next_action), '') IS NOT NULL OR c.next_action_date IS NOT NULL)

    UNION ALL
    -- 2) 跟进行动：每个客户最新一条跟进记录中承诺的下一步
    SELECT
        ('followup-' || lf."Id")                         AS action_id,
        'followup'::text                                 AS action_type,
        'customer'::text                                 AS person_type,
        lf.customer_id::bigint                           AS person_id,
        lf.customer_name                                 AS person_name,
        ('跟进回访 · ' || lf.customer_name)              AS title,
        COALESCE(NULLIF(btrim(lf.next_action), ''),
                 NULLIF(btrim(lf.interaction_summary), ''),
                 lf.next_followup_goal::text)            AS next_action,
        COALESCE(lf.next_action_date, lf.next_followup_date) AS action_date,
        NULL::text                                       AS priority,
        'followups'::text                                AS source,
        c2.customer_stage::text                          AS stage,
        (COALESCE(lf.next_action_date, lf.next_followup_date) - CURRENT_DATE) AS days_until,
        lf.followup_date                                 AS last_followup_date
    FROM (
        SELECT DISTINCT ON (f.customer_id)
               f."Id", f.customer_id, f.customer_name, f.followup_date,
               f.next_action, f.next_action_date, f.next_followup_date,
               f.next_followup_goal, f.interaction_summary
        FROM public.followups f
        WHERE f.deleted_at IS NULL
          AND (f.next_action_date IS NOT NULL
               OR f.next_followup_date IS NOT NULL
               OR NULLIF(btrim(f.next_action), '') IS NOT NULL)
        ORDER BY f.customer_id, f.followup_date DESC NULLS LAST, f."Id" DESC
    ) lf
    LEFT JOIN public.customers c2
           ON c2."Id" = lf.customer_id AND c2.deleted_at IS NULL

    UNION ALL
    -- 3) 机会行动：未成交/未关闭的经营机会（含转介绍线索）
    SELECT
        ('opportunity-' || o.id)                         AS action_id,
        'opportunity'::text                              AS action_type,
        'customer'::text                                 AS person_type,
        o.customer_id::bigint                            AS person_id,
        COALESCE(c3.customer_name, '客户#' || o.customer_id) AS person_name,
        (o.opportunity_type || '机会跟进 · ' ||
         COALESCE(c3.customer_name, '客户#' || o.customer_id)) AS title,
        COALESCE(NULLIF(btrim(o.next_action), ''),
                 NULLIF(btrim(o.last_progress), ''))     AS next_action,
        o.next_action_date                               AS action_date,
        NULL::text                                       AS priority,
        'opportunities'::text                            AS source,
        o.status                                         AS stage,
        (o.next_action_date - CURRENT_DATE)              AS days_until,
        (SELECT max(f.followup_date) FROM public.followups f
          WHERE f.customer_id = o.customer_id AND f.deleted_at IS NULL) AS last_followup_date
    FROM public.opportunities o
    LEFT JOIN public.customers c3
           ON c3."Id" = o.customer_id AND c3.deleted_at IS NULL
    WHERE o.deleted_at IS NULL
      AND o.status NOT IN ('成交', '关闭')

    UNION ALL
    -- 4) 增员行动：候选人档案上的下一步行动
    SELECT
        ('recruit-' || rc.id)                            AS action_id,
        'recruit'::text                                  AS action_type,
        'recruit'::text                                  AS person_type,
        rc.id::bigint                                    AS person_id,
        c4.customer_name                                 AS person_name,
        ('增员推进 · ' || c4.customer_name || '（' || rc.stage || '）') AS title,
        NULLIF(btrim(rc.next_action), '')                AS next_action,
        rc.next_action_date                              AS action_date,
        NULL::text                                       AS priority,
        'recruit_candidates'::text                       AS source,
        rc.stage                                         AS stage,
        (rc.next_action_date - CURRENT_DATE)             AS days_until,
        (SELECT max(rf.followup_date) FROM public.recruit_followups rf
          WHERE rf.candidate_id = rc.id AND rf.deleted_at IS NULL) AS last_followup_date
    FROM public.recruit_candidates rc
    JOIN public.customers c4
      ON c4."Id" = rc.customer_id AND c4.deleted_at IS NULL
    WHERE rc.deleted_at IS NULL
      AND rc.stage <> '流失'
      AND (NULLIF(btrim(rc.next_action), '') IS NOT NULL OR rc.next_action_date IS NOT NULL)

    UNION ALL
    -- 5) 增员跟进行动：每个候选人最新一条增员跟进
    SELECT
        ('recruit_followup-' || lr.id)                   AS action_id,
        'recruit_followup'::text                         AS action_type,
        'recruit'::text                                  AS person_type,
        lr.candidate_id::bigint                          AS person_id,
        COALESCE(c5.customer_name, '候选人#' || lr.candidate_id) AS person_name,
        ('增员跟进 · ' ||
         COALESCE(c5.customer_name, '候选人#' || lr.candidate_id)) AS title,
        COALESCE(NULLIF(btrim(lr.next_action), ''),
                 NULLIF(btrim(lr.interaction_summary), ''),
                 NULLIF(btrim(lr.next_followup_goal), '')) AS next_action,
        COALESCE(lr.next_action_date, lr.next_followup_date) AS action_date,
        NULL::text                                       AS priority,
        'recruit_followups'::text                        AS source,
        rc5.stage                                        AS stage,
        (COALESCE(lr.next_action_date, lr.next_followup_date) - CURRENT_DATE) AS days_until,
        lr.followup_date                                 AS last_followup_date
    FROM (
        SELECT DISTINCT ON (rf.candidate_id)
               rf.id, rf.candidate_id, rf.followup_date,
               rf.next_action, rf.next_action_date, rf.next_followup_date,
               rf.next_followup_goal, rf.interaction_summary
        FROM public.recruit_followups rf
        WHERE rf.deleted_at IS NULL
          AND (rf.next_action_date IS NOT NULL
               OR rf.next_followup_date IS NOT NULL
               OR NULLIF(btrim(rf.next_action), '') IS NOT NULL)
        ORDER BY rf.candidate_id, rf.followup_date DESC, rf.id DESC
    ) lr
    JOIN public.recruit_candidates rc5
      ON rc5.id = lr.candidate_id AND rc5.deleted_at IS NULL
    LEFT JOIN public.customers c5
      ON c5."Id" = rc5.customer_id AND c5.deleted_at IS NULL

    UNION ALL
    -- 6) 活动任务行动：未完成（pending/in_progress）的活动待办；activity_tasks 为硬删除表
    SELECT
        ('activity_task-' || t.id)                       AS action_id,
        'activity_task'::text                            AS action_type,
        'activity'::text                                 AS person_type,
        t.activity_id::bigint                            AS person_id,
        COALESCE(a.name, '活动#' || t.activity_id)       AS person_name,
        (COALESCE(a.name, '活动#' || t.activity_id) || ' · ' || t.task_title) AS title,
        COALESCE(NULLIF(btrim(t.note), ''), t.task_title) AS next_action,
        t.due_date                                       AS action_date,
        t.priority                                       AS priority,
        'activity_tasks'::text                           AS source,
        t.status                                         AS stage,
        (t.due_date - CURRENT_DATE)                      AS days_until,
        NULL::date                                       AS last_followup_date
    FROM public.activity_tasks t
    LEFT JOIN public.activities a
      ON a.id = t.activity_id AND a.deleted_at IS NULL
    WHERE t.status IN ('pending', 'in_progress')
      AND a.deleted_at IS NULL
) v;

COMMENT ON VIEW public.v_action_center IS 'v1.8 Sprint 2 Action Center 统一行动视图：汇总客户/跟进/机会/增员/增员跟进/活动任务的下一步行动；status(overdue/today/upcoming/unscheduled)、days_until、last_followup_date 均为 SQL 计算事实，供 Today Coach 排序使用';

GRANT SELECT ON public.v_action_center TO anon, authenticated, service_role;
