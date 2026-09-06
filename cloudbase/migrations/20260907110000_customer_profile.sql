-- ============================================================
-- 20260907110000_customer_profile.sql
-- 轻量客户画像：customers 增加 profile jsonb 列（8 维度，AI 自动提取为主）
-- 并按规范重建依赖视图 customers_view（补列 + 重新授权）
--
-- profile 结构：
--   { family, children, parents, career, needs, relationship, events:[{date,text}] }
--   兴趣爱好复用 customers.hobbies；职业复用 customers.occupation，不重复存储。
--   旧记录 profile 为 NULL，画像区按空值展示，完全兼容。
-- ============================================================

-- 1) 基表加列（可空，无默认值，不影响存量行）
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS profile jsonb;

COMMENT ON COLUMN public.customers.profile IS
  '轻量客户画像 {family家庭情况,children子女情况,parents父母情况,career事业状态,needs当前主要需求,relationship关系程度,events:[{date,text}]}；兴趣爱好/职业复用 hobbies/occupation 列；由 ai_followup 提取、操作者确认后写入';

-- 2) 重建依赖视图（PG 视图创建时绑定列清单，加列后必须 DROP+CREATE 才能带出新列）
DROP VIEW IF EXISTS public.customers_view;

CREATE VIEW public.customers_view AS
 SELECT c."Id",
    c.customer_name,
    c.sales_priority,
    c.recruitment_priority,
    c.referral_priority,
    c.hobbies,
    c.additional_info,
    c.gender,
    c.source,
    c.tags,
    c.marital_status,
    c.properties_info,
    c.occupation,
    c.annual_income,
    c.household_income,
    c.updated_at,
    c.created_at,
    c.first_contact_date,
    c.birthday,
    c.customer_stage,
    c.phone,
    c.profile,
    c.deleted_at,
        CASE
            WHEN (c.birthday IS NOT NULL) THEN ((EXTRACT(year FROM age(now(), (c.birthday)::timestamp with time zone)))::integer +
            CASE
                WHEN (EXTRACT(month FROM age(now(), (c.birthday)::timestamp with time zone)) > (0)::numeric) THEN 1
                ELSE 0
            END)
            ELSE NULL::integer
        END AS age,
        CASE
            WHEN (c.first_contact_date IS NOT NULL) THEN ((EXTRACT(year FROM (now() - (c.first_contact_date)::timestamp with time zone)))::integer +
            CASE
                WHEN (EXTRACT(month FROM (now() - (c.first_contact_date)::timestamp with time zone)) > (0)::numeric) THEN 1
                ELSE 0
            END)
            ELSE NULL::integer
        END AS contact_years,
    g.gift_name,
    g.quantity AS gift_quantity,
    g.notes AS gift_notes,
    g.given_date,
    f.followup_notes,
    f.followup_date,
    f.next_followup_date,
    f.next_followup_goal,
    a.recommendation_date,
    a.suggested_followup_date,
    a.suggested_message,
    a.suggested_strategy,
    a.suggested_customer_stage,
    a.suggested_followup_goal,
    p.photo_url,
    p.thumbnail_url,
    p.file_name,
    p.content_type
   FROM ((((customers c
     LEFT JOIN LATERAL ( SELECT gifts."Id",
            gifts.customer_name,
            gifts.gift_name,
            gifts.quantity,
            gifts.notes,
            gifts.given_date,
            gifts.customer_id,
            gifts.created_at
           FROM gifts
          WHERE (gifts.customer_id = c."Id")
          ORDER BY gifts.created_at DESC
         LIMIT 1) g ON (true))
     LEFT JOIN LATERAL ( SELECT followups."Id",
            followups.customer_name,
            followups.followup_notes,
            followups.followup_date,
            followups.next_followup_date,
            followups.next_followup_goal,
            followups.customer_id,
            followups.created_at,
            followups.updated_at
           FROM followups
          WHERE (followups.customer_id = c."Id")
          ORDER BY followups.created_at DESC
         LIMIT 1) f ON (true))
     LEFT JOIN LATERAL ( SELECT ai_recommendations.id,
            ai_recommendations.created_at,
            ai_recommendations.customer_name,
            ai_recommendations.recommendation_date,
            ai_recommendations.suggested_followup_date,
            ai_recommendations.suggested_message,
            ai_recommendations.suggested_strategy,
            ai_recommendations.suggested_customer_stage,
            ai_recommendations.suggested_followup_goal,
            ai_recommendations.customer_id
           FROM ai_recommendations
          WHERE (ai_recommendations.customer_id = c."Id")
          ORDER BY ai_recommendations.created_at DESC
         LIMIT 1) a ON (true))
     LEFT JOIN LATERAL ( SELECT photos.id,
            photos.customer_id,
            photos.photo_url,
            photos.thumbnail_url,
            photos.file_name,
            photos.content_type,
            photos.sort_order,
            photos.created_at,
            photos.customer_name
           FROM photos
          WHERE (photos.customer_id = c."Id")
          ORDER BY photos.created_at DESC
         LIMIT 1) p ON (true))
  ORDER BY c."Id" DESC;

COMMENT ON VIEW public.customers_view IS
  '客户聚合视图（20260907110000 重建：补 profile 列，随基表 customers）';

-- 3) DROP 后授权丢失，按原授权恢复
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.customers_view TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.customers_view TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.customers_view TO cloudbase_postgres_pgdb_pn3idppt;
