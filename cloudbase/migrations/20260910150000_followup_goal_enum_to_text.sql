-- 修复 v1.8.10：followups.next_followup_goal / ai_recommendations.suggested_followup_goal
-- 原 ENUM('跟进目标', 7 固定值)，Sprint10 UI 改自由文本后 AI 产出长句子无法写入
-- ALTER 被阻塞需先 DROP 所有依赖视图；v_funnel_stats 依赖 v_action_center，故用 CASCADE 级联
-- 现有 17 条 enum 值（短文本）改 TEXT 后自然兼容

-- ============== 1. DROP 7 个依赖视图（级联 v_funnel_stats） ==============
DROP VIEW IF EXISTS public.v_funnel_stats;       -- 依赖 v_action_center
DROP VIEW IF EXISTS public.v_action_center CASCADE;
DROP VIEW IF EXISTS public.followups_view;
DROP VIEW IF EXISTS public.ai_recommendations_view;
DROP VIEW IF EXISTS public.customers_view;
DROP VIEW IF EXISTS public.products_view;
DROP VIEW IF EXISTS public.gifts_view;

-- ============== 2. ALTER 两列 ENUM → TEXT ==============
ALTER TABLE public.followups ALTER COLUMN next_followup_goal TYPE text USING next_followup_goal::text;
ALTER TABLE public.ai_recommendations ALTER COLUMN suggested_followup_goal TYPE text USING suggested_followup_goal::text;
DROP TYPE IF EXISTS public."跟进目标";

-- ============== 3. CREATE VIEW followups_view ==============
CREATE VIEW public.followups_view AS
 SELECT f."Id", f.customer_name, f.followup_notes, f.followup_date, f.next_followup_date, f.next_followup_goal, f.customer_id, f.created_at,
        c.gender, c.occupation, c.tags, c.customer_stage,
        g.gift_name, g.quantity, g.given_date,
        a.suggested_message, a.suggested_strategy, a.suggested_followup_date
   FROM followups f
     LEFT JOIN customers c ON f.customer_id = c."Id"
     LEFT JOIN LATERAL ( SELECT gifts."Id", gifts.customer_name, gifts.gift_name, gifts.quantity, gifts.notes, gifts.given_date, gifts.customer_id, gifts.created_at FROM gifts WHERE gifts.customer_id = f.customer_id ORDER BY gifts.created_at DESC LIMIT 1) g ON true
     LEFT JOIN LATERAL ( SELECT ai_recommendations.id, ai_recommendations.created_at, ai_recommendations.customer_name, ai_recommendations.recommendation_date, ai_recommendations.suggested_followup_date, ai_recommendations.suggested_message, ai_recommendations.suggested_strategy, ai_recommendations.suggested_customer_stage, ai_recommendations.suggested_followup_goal, ai_recommendations.customer_id FROM ai_recommendations WHERE ai_recommendations.customer_id = f.customer_id ORDER BY ai_recommendations.created_at DESC LIMIT 1) a ON true;

-- ============== 4. CREATE VIEW ai_recommendations_view ==============
CREATE VIEW public.ai_recommendations_view AS
 SELECT a.id, a.created_at, a.customer_name, a.recommendation_date, a.suggested_followup_date, a.suggested_message, a.suggested_strategy, a.suggested_customer_stage, a.suggested_followup_goal, a.nba, a.customer_id,
        c.gender, c.occupation, c.tags, c.customer_stage,
        f.followup_notes, f.followup_date, f.next_followup_date,
        g.gift_name, g.quantity, g.given_date
   FROM ai_recommendations a
     LEFT JOIN customers c ON a.customer_id = c."Id"
     LEFT JOIN LATERAL ( SELECT followups."Id", followups.customer_name, followups.followup_notes, followups.followup_date, followups.next_followup_date, followups.next_followup_goal, followups.customer_id, followups.created_at FROM followups WHERE followups.customer_id = a.customer_id ORDER BY followups.created_at DESC LIMIT 1) f ON true
     LEFT JOIN LATERAL ( SELECT gifts."Id", gifts.customer_name, gifts.gift_name, gifts.quantity, gifts.notes, gifts.given_date, gifts.customer_id, gifts.created_at FROM gifts WHERE gifts.customer_id = a.customer_id ORDER BY gifts.created_at DESC LIMIT 1) g ON true;

-- ============== 5. CREATE VIEW customers_view ==============
CREATE VIEW public.customers_view AS
 SELECT c."Id", c.customer_name, c.sales_priority, c.recruitment_priority, c.referral_priority, c.hobbies, c.additional_info, c.gender, c.source, c.tags, c.marital_status, c.properties_info, c.occupation, c.annual_income, c.household_income, c.updated_at, c.created_at, c.first_contact_date, c.birthday, c.customer_stage, c.phone, c.profile, c.deleted_at,
        CASE WHEN c.birthday IS NOT NULL THEN EXTRACT(year FROM age(now(), c.birthday::timestamp with time zone))::integer + CASE WHEN EXTRACT(month FROM age(now(), c.birthday::timestamp with time zone)) > 0::numeric THEN 1 ELSE 0 END ELSE NULL::integer END AS age,
        CASE WHEN c.first_contact_date IS NOT NULL THEN EXTRACT(year FROM now() - c.first_contact_date::timestamp with time zone)::integer + CASE WHEN EXTRACT(month FROM now() - c.first_contact_date::timestamp with time zone) > 0::numeric THEN 1 ELSE 0 END ELSE NULL::integer END AS contact_years,
        g.gift_name, g.quantity AS gift_quantity, g.notes AS gift_notes, g.given_date,
        f.followup_notes, f.followup_date, f.next_followup_date, f.next_followup_goal,
        a.recommendation_date, a.suggested_followup_date, a.suggested_message, a.suggested_strategy, a.suggested_customer_stage, a.suggested_followup_goal,
        p.photo_url, p.thumbnail_url, p.file_name, p.content_type
   FROM customers c
     LEFT JOIN LATERAL ( SELECT gifts."Id", gifts.customer_name, gifts.gift_name, gifts.quantity, gifts.notes, gifts.given_date, gifts.customer_id, gifts.created_at FROM gifts WHERE gifts.customer_id = c."Id" ORDER BY gifts.created_at DESC LIMIT 1) g ON true
     LEFT JOIN LATERAL ( SELECT followups."Id", followups.customer_name, followups.followup_notes, followups.followup_date, followups.next_followup_date, followups.next_followup_goal, followups.customer_id, followups.created_at, followups.updated_at FROM followups WHERE followups.customer_id = c."Id" ORDER BY followups.created_at DESC LIMIT 1) f ON true
     LEFT JOIN LATERAL ( SELECT ai_recommendations.id, ai_recommendations.created_at, ai_recommendations.customer_name, ai_recommendations.recommendation_date, ai_recommendations.suggested_followup_date, ai_recommendations.suggested_message, ai_recommendations.suggested_strategy, ai_recommendations.suggested_customer_stage, ai_recommendations.suggested_followup_goal, ai_recommendations.customer_id FROM ai_recommendations WHERE ai_recommendations.customer_id = c."Id" ORDER BY ai_recommendations.created_at DESC LIMIT 1) a ON true
     LEFT JOIN LATERAL ( SELECT photos.id, photos.customer_id, photos.photo_url, photos.thumbnail_url, photos.file_name, photos.content_type, photos.sort_order, photos.created_at, photos.customer_name FROM photos WHERE photos.customer_id = c."Id" ORDER BY photos.created_at DESC LIMIT 1) p ON true
  ORDER BY c."Id" DESC;

-- ============== 6. CREATE VIEW gifts_view ==============
CREATE VIEW public.gifts_view AS
 SELECT g."Id", g.customer_name, g.gift_name, g.quantity, g.notes, g.given_date, g.customer_id, g.created_at,
        c.gender, c.occupation, c.tags, c.customer_stage, c.source,
        f.followup_notes, f.followup_date, f.next_followup_date, f.next_followup_goal,
        a.recommendation_date, a.suggested_followup_date, a.suggested_message, a.suggested_strategy, a.suggested_customer_stage, a.suggested_followup_goal
   FROM gifts g
     LEFT JOIN LATERAL ( SELECT customers."Id", customers.customer_name, customers.sales_priority, customers.recruitment_priority, customers.referral_priority, customers.hobbies, customers.additional_info, customers.gender, customers.source, customers.tags, customers.marital_status, customers.properties_info, customers.occupation, customers.annual_income, customers.household_income, customers.updated_at, customers.created_at, customers.first_contact_date, customers.birthday, customers.customer_stage, customers.phone, customers.deleted_at FROM customers WHERE customers."Id" = g.customer_id ORDER BY customers.updated_at DESC LIMIT 1) c ON true
     LEFT JOIN LATERAL ( SELECT followups."Id", followups.customer_name, followups.followup_notes, followups.followup_date, followups.next_followup_date, followups.next_followup_goal, followups.customer_id, followups.created_at, followups.updated_at FROM followups WHERE followups.customer_id = g.customer_id ORDER BY followups.created_at DESC LIMIT 1) f ON true
     LEFT JOIN LATERAL ( SELECT ai_recommendations.id, ai_recommendations.created_at, ai_recommendations.customer_name, ai_recommendations.recommendation_date, ai_recommendations.suggested_followup_date, ai_recommendations.suggested_message, ai_recommendations.suggested_strategy, ai_recommendations.suggested_customer_stage, ai_recommendations.suggested_followup_goal, ai_recommendations.customer_id FROM ai_recommendations WHERE ai_recommendations.customer_id = g.customer_id ORDER BY ai_recommendations.created_at DESC LIMIT 1) a ON true
  ORDER BY g.given_date DESC NULLS LAST;

-- ============== 7. CREATE VIEW products_view ==============
CREATE VIEW public.products_view AS
 SELECT p.id, p.created_at, p.customer_id, p.customer_name, p.ap_ipa, p.ap_ltc, p.ap_ann, p.ap_life, p.ap_term, p.ap_wl, p.ap_pa, p.ap_ci, p.ap_hi, p.ap_all,
        c.gender, c.occupation, c.tags, c.customer_stage, c.source,
        f.followup_notes, f.followup_date, f.next_followup_date, f.next_followup_goal,
        a.recommendation_date, a.suggested_followup_date, a.suggested_message, a.suggested_strategy, a.suggested_customer_stage, a.suggested_followup_goal,
        g.gift_name, g.quantity AS gift_quantity, g.given_date, g.notes AS gift_notes
   FROM products p
     LEFT JOIN customers c ON p.customer_id = c."Id"
     LEFT JOIN LATERAL ( SELECT followups."Id", followups.customer_name, followups.followup_notes, followups.followup_date, followups.next_followup_date, followups.next_followup_goal, followups.customer_id, followups.created_at FROM followups WHERE followups.customer_id = p.customer_id ORDER BY followups.created_at DESC LIMIT 1) f ON true
     LEFT JOIN LATERAL ( SELECT ai_recommendations.id, ai_recommendations.created_at, ai_recommendations.customer_name, ai_recommendations.recommendation_date, ai_recommendations.suggested_followup_date, ai_recommendations.suggested_message, ai_recommendations.suggested_strategy, ai_recommendations.suggested_customer_stage, ai_recommendations.suggested_followup_goal, ai_recommendations.customer_id FROM ai_recommendations WHERE ai_recommendations.customer_id = p.customer_id ORDER BY ai_recommendations.created_at DESC LIMIT 1) a ON true
     LEFT JOIN LATERAL ( SELECT gifts."Id", gifts.customer_name, gifts.gift_name, gifts.quantity, gifts.notes, gifts.given_date, gifts.customer_id, gifts.created_at FROM gifts WHERE gifts.customer_id = p.customer_id ORDER BY gifts.created_at DESC LIMIT 1) g ON true;

-- ============== 8. CREATE VIEW v_action_center ==============
-- 注意：next_followup_goal 列已从 ENUM 改为 TEXT，不再需要 ::text cast
CREATE VIEW public.v_action_center AS
 SELECT action_id, action_type, person_type, person_id, person_name, title, next_action, action_date, priority, source,
        CASE WHEN action_date IS NULL THEN 'unscheduled'::text WHEN action_date < CURRENT_DATE THEN 'overdue'::text WHEN action_date = CURRENT_DATE THEN 'today'::text WHEN action_date > CURRENT_DATE THEN 'upcoming'::text ELSE NULL::text END AS status,
        stage, days_until, last_followup_date
   FROM (
     SELECT 'customer-'::text || c."Id" AS action_id, 'customer'::text AS action_type, 'customer'::text AS person_type,
            c."Id"::bigint AS person_id, c.customer_name AS person_name, '客户经营 · '::text || c.customer_name AS title,
            NULLIF(btrim(c.next_action), ''::text) AS next_action, c.next_action_date AS action_date,
            c.sales_priority::text AS priority, 'customers'::text AS source, c.customer_stage::text AS stage,
            c.next_action_date - CURRENT_DATE AS days_until,
            (SELECT max(f.followup_date) FROM followups f WHERE f.customer_id = c."Id" AND f.deleted_at IS NULL) AS last_followup_date
       FROM customers c WHERE c.deleted_at IS NULL AND (NULLIF(btrim(c.next_action), ''::text) IS NOT NULL OR c.next_action_date IS NOT NULL)
     UNION ALL
     SELECT 'followup-'::text || lf."Id", 'followup'::text, 'customer'::text, lf.customer_id::bigint, lf.customer_name, '跟进回访 · '::text || lf.customer_name,
            COALESCE(NULLIF(btrim(lf.next_action), ''::text), NULLIF(btrim(lf.interaction_summary), ''::text), lf.next_followup_goal),
            COALESCE(lf.next_action_date, lf.next_followup_date), NULL::text, 'followups'::text, c2.customer_stage::text,
            COALESCE(lf.next_action_date, lf.next_followup_date) - CURRENT_DATE, lf.followup_date
       FROM (SELECT DISTINCT ON (f.customer_id) f."Id", f.customer_id, f.customer_name, f.followup_date, f.next_action, f.next_action_date, f.next_followup_date, f.next_followup_goal, f.interaction_summary FROM followups f WHERE f.deleted_at IS NULL AND (f.next_action_date IS NOT NULL OR f.next_followup_date IS NOT NULL OR NULLIF(btrim(f.next_action), ''::text) IS NOT NULL) ORDER BY f.customer_id, f.followup_date DESC NULLS LAST, f."Id" DESC) lf
       LEFT JOIN customers c2 ON c2."Id" = lf.customer_id AND c2.deleted_at IS NULL
     UNION ALL
     SELECT 'opportunity-'::text || o.id, 'opportunity'::text, 'customer'::text, o.customer_id::bigint,
            COALESCE(c3.customer_name, '客户#'::text || o.customer_id), (o.opportunity_type || '机会跟进 · '::text) || COALESCE(c3.customer_name, '客户#'::text || o.customer_id),
            COALESCE(NULLIF(btrim(o.next_action), ''::text), NULLIF(btrim(o.last_progress), ''::text)),
            o.next_action_date, NULL::text, 'opportunities'::text, o.status,
            o.next_action_date - CURRENT_DATE,
            (SELECT max(f.followup_date) FROM followups f WHERE f.customer_id = o.customer_id AND f.deleted_at IS NULL)
       FROM opportunities o LEFT JOIN customers c3 ON c3."Id" = o.customer_id AND c3.deleted_at IS NULL
       WHERE o.deleted_at IS NULL AND (o.status <> ALL (ARRAY['成交'::text, '关闭'::text]))
     UNION ALL
     SELECT 'recruit-'::text || rc.id, 'recruit'::text, 'recruit'::text, rc.id, c4.customer_name,
            ((('增员推进 · '::text || c4.customer_name) || '（'::text) || rc.stage) || '）'::text,
            NULLIF(btrim(rc.next_action), ''::text), rc.next_action_date, NULL::text, 'recruit_candidates'::text, rc.stage,
            rc.next_action_date - CURRENT_DATE,
            (SELECT max(rf.followup_date) FROM recruit_followups rf WHERE rf.candidate_id = rc.id AND rf.deleted_at IS NULL)
       FROM recruit_candidates rc JOIN customers c4 ON c4."Id" = rc.customer_id AND c4.deleted_at IS NULL
       WHERE rc.deleted_at IS NULL AND rc.stage <> '流失'::text AND (NULLIF(btrim(rc.next_action), ''::text) IS NOT NULL OR rc.next_action_date IS NOT NULL)
     UNION ALL
     SELECT 'recruit_followup-'::text || lr.id, 'recruit_followup'::text, 'recruit'::text, lr.candidate_id,
            COALESCE(c5.customer_name, '候选人#'::text || lr.candidate_id), '增员跟进 · '::text || COALESCE(c5.customer_name, '候选人#'::text || lr.candidate_id),
            COALESCE(NULLIF(btrim(lr.next_action), ''::text), NULLIF(btrim(lr.interaction_summary), ''::text), NULLIF(btrim(lr.next_followup_goal), ''::text)),
            COALESCE(lr.next_action_date, lr.next_followup_date), NULL::text, 'recruit_followups'::text, rc5.stage,
            COALESCE(lr.next_action_date, lr.next_followup_date) - CURRENT_DATE, lr.followup_date
       FROM (SELECT DISTINCT ON (rf.candidate_id) rf.id, rf.candidate_id, rf.followup_date, rf.next_action, rf.next_action_date, rf.next_followup_date, rf.next_followup_goal, rf.interaction_summary FROM recruit_followups rf WHERE rf.deleted_at IS NULL AND (rf.next_action_date IS NOT NULL OR rf.next_followup_date IS NOT NULL OR NULLIF(btrim(rf.next_action), ''::text) IS NOT NULL) ORDER BY rf.candidate_id, rf.followup_date DESC, rf.id DESC) lr
       JOIN recruit_candidates rc5 ON rc5.id = lr.candidate_id AND rc5.deleted_at IS NULL
       LEFT JOIN customers c5 ON c5."Id" = rc5.customer_id AND c5.deleted_at IS NULL
     UNION ALL
     SELECT 'activity_task-'::text || t.id, 'activity_task'::text, 'activity'::text, t.activity_id,
            COALESCE(a.name, '活动#'::text || t.activity_id), (COALESCE(a.name, '活动#'::text || t.activity_id) || ' · '::text) || t.task_title,
            COALESCE(NULLIF(btrim(t.note), ''::text), t.task_title), t.due_date, t.priority, 'activity_tasks'::text, t.status,
            t.due_date - CURRENT_DATE, NULL::date
       FROM activity_tasks t LEFT JOIN activities a ON a.id = t.activity_id AND a.deleted_at IS NULL
       WHERE (t.status = ANY (ARRAY['pending'::text, 'in_progress'::text])) AND a.deleted_at IS NULL
   ) v;

-- 视图不支持 RLS（PG 限制），基表已有 RLS 策略保护，无需对视图启用

-- ============== 9. CREATE VIEW v_funnel_stats（依赖 v_action_center，必须最后建） ==============
CREATE VIEW public.v_funnel_stats AS
 WITH dim AS (
  SELECT 'customer'::text AS funnel, e.enumlabel::text AS stage, e.enumsortorder::integer AS stage_order, 'active'::text AS kind
   FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = '客户经营阶段'::name
  UNION ALL SELECT 'customer'::text, '未分层'::text, 0, 'unclassified'::text
  UNION ALL SELECT 'opportunity', stage, stage_order, kind FROM (VALUES ('opportunity','发现',1,'active'),('opportunity','沟通',2,'active'),('opportunity','方案',3,'active'),('opportunity','成交',4,'terminal'),('opportunity','关闭',5,'terminal')) vopp(funnel, stage, stage_order, kind)
  UNION ALL SELECT 'recruit', stage, stage_order, kind FROM (VALUES ('recruit','新增人才',1,'active'),('recruit','互动暖客',2,'active'),('recruit','初次面谈',3,'active'),('recruit','增员活动',4,'active'),('recruit','精准面谈',5,'active'),('recruit','入职申请',6,'active'),('recruit','签约入司',7,'terminal')) vrc(funnel, stage, stage_order, kind)
 ), fact AS (
  SELECT 'customer'::text AS funnel, COALESCE(c.customer_stage::text, '未分层'::text) AS stage,
         count(*) AS current_count,
         count(*) FILTER (WHERE c.created_at >= (now() - '30 days'::interval)) AS entered_30d,
         NULL::bigint AS moved_30d,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM v_action_center a WHERE a.person_type = 'customer'::text AND a.person_id = c."Id" AND a.status = 'overdue'::text)) AS overdue_count,
         NULL::integer AS dwell_median_days, NULL::bigint AS stuck_count
    FROM customers c WHERE c.deleted_at IS NULL GROUP BY COALESCE(c.customer_stage::text, '未分层'::text)
  UNION ALL
  SELECT 'opportunity', o.status,
         count(*),
         count(*) FILTER (WHERE COALESCE(o.discovered_at, o.created_at::date) >= (CURRENT_DATE - 30)),
         NULL,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM v_action_center a WHERE a.action_type = 'opportunity'::text AND a.person_id = o.id AND a.status = 'overdue'::text)),
         percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (CURRENT_DATE - COALESCE(o.discovered_at, o.created_at::date))::double precision) FILTER (WHERE o.status <> ALL (ARRAY['成交'::text, '关闭'::text]))::integer,
         count(*) FILTER (WHERE o.status <> ALL (ARRAY['成交'::text, '关闭'::text]) AND (CURRENT_DATE - COALESCE(o.discovered_at, o.created_at::date)) >= 60)
    FROM opportunities o WHERE o.deleted_at IS NULL GROUP BY o.status
  UNION ALL
  SELECT 'recruit', rc.stage,
         count(*),
         count(*) FILTER (WHERE rc.created_at >= (now() - '30 days'::interval)),
         count(*) FILTER (WHERE rc.stage_changed_at >= (now() - '30 days'::interval) AND rc.created_at < (now() - '30 days'::interval)),
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM v_action_center a WHERE a.person_type = 'recruit'::text AND a.person_id = rc.id AND a.status = 'overdue'::text)),
         percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (CURRENT_DATE - rc.stage_changed_at::date)::double precision) FILTER (WHERE rc.stage <> '签约入司'::text AND rc.stage_changed_at IS NOT NULL)::integer,
         count(*) FILTER (WHERE rc.stage <> ALL (ARRAY['签约入司'::text, '流失'::text]) AND (CURRENT_DATE - rc.stage_changed_at::date) >= 30)
    FROM recruit_candidates rc WHERE rc.deleted_at IS NULL GROUP BY rc.stage
 ), extra AS (
  SELECT f.funnel, f.stage, (90 + row_number() OVER (PARTITION BY f.funnel ORDER BY f.stage))::integer AS stage_order,
         CASE WHEN f.stage = ANY (ARRAY['流失'::text, '关闭'::text, '成交'::text]) THEN 'terminal'::text ELSE 'other'::text END AS kind,
         f.current_count, f.entered_30d, f.moved_30d, f.overdue_count, f.dwell_median_days, f.stuck_count
    FROM fact f WHERE NOT EXISTS (SELECT 1 FROM dim d WHERE d.funnel = f.funnel AND d.stage = f.stage)
 )
 SELECT d.funnel, d.stage, d.stage_order, d.kind,
        COALESCE(f.current_count, 0::bigint) AS current_count, COALESCE(f.entered_30d, 0::bigint) AS entered_30d, f.moved_30d,
        COALESCE(f.overdue_count, 0::bigint) AS overdue_count, f.dwell_median_days, f.stuck_count
   FROM dim d LEFT JOIN fact f ON f.funnel = d.funnel AND f.stage = d.stage
 UNION ALL
 SELECT e.funnel, e.stage, e.stage_order, e.kind, e.current_count, e.entered_30d, e.moved_30d, e.overdue_count, e.dwell_median_days, e.stuck_count
   FROM extra e ORDER BY 1, 3;

-- ============== 10. GRANT 所有 7 个视图（DROP VIEW 会丢 GRANT） ==============
-- 基础角色（云函数用）
GRANT SELECT ON public.followups_view TO anon;
GRANT SELECT ON public.ai_recommendations_view TO anon;
GRANT SELECT ON public.customers_view TO anon;
GRANT SELECT ON public.products_view TO anon;
GRANT SELECT ON public.gifts_view TO anon;
GRANT SELECT ON public.v_action_center TO anon;
GRANT SELECT ON public.v_funnel_stats TO anon;

-- authenticated（旧设计保留）
GRANT ALL ON public.followups_view TO authenticated;
GRANT ALL ON public.ai_recommendations_view TO authenticated;
GRANT ALL ON public.customers_view TO authenticated;
GRANT ALL ON public.products_view TO authenticated;
GRANT ALL ON public.gifts_view TO authenticated;
GRANT ALL ON public.v_action_center TO authenticated;
GRANT ALL ON public.v_funnel_stats TO authenticated;

-- service_role
GRANT ALL ON public.followups_view TO service_role;
GRANT ALL ON public.ai_recommendations_view TO service_role;
GRANT ALL ON public.customers_view TO service_role;
GRANT ALL ON public.products_view TO service_role;
GRANT ALL ON public.gifts_view TO service_role;
GRANT ALL ON public.v_action_center TO service_role;
GRANT ALL ON public.v_funnel_stats TO service_role;
