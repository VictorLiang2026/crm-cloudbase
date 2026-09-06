-- ============================================================
-- 20260907090000_ai_recommend_nba.sql
-- Next Best Action（下一最佳行动）：ai_recommendations 增加 nba jsonb 列
-- 并按规范重建依赖视图 ai_recommendations_view（补列 + 重新授权）
--
-- 背景：AI 跟进建议升级为 NBA 7 字段结构（当前经营判断/经营目标/下一最佳行动/
--       推荐沟通主题/不建议做什么/成功标准/建议下一次跟进时间）。
--       前 6 个结构化字段存入 nba jsonb；第 7 项复用既有 suggested_followup_date。
--       旧记录 nba 为 NULL，前端按旧格式渲染，历史完全兼容。
-- ============================================================

-- 1) 基表加列（可空，无默认值，不影响存量行）
ALTER TABLE public.ai_recommendations ADD COLUMN IF NOT EXISTS nba jsonb;

COMMENT ON COLUMN public.ai_recommendations.nba IS
  'Next Best Action 结构化建议 {assessment,goal,next_action,topic,avoid,success_criteria}，随 ai_recommend 生成写入；建议下一次跟进时间复用 suggested_followup_date';

-- 2) 重建依赖视图（PG 视图在创建时绑定列清单，加列后必须 DROP+CREATE 才能带出新列）
DROP VIEW IF EXISTS public.ai_recommendations_view;

CREATE VIEW public.ai_recommendations_view AS
 SELECT a.id,
    a.created_at,
    a.customer_name,
    a.recommendation_date,
    a.suggested_followup_date,
    a.suggested_message,
    a.suggested_strategy,
    a.suggested_customer_stage,
    a.suggested_followup_goal,
    a.nba,
    a.customer_id,
    c.gender,
    c.occupation,
    c.tags,
    c.customer_stage,
    f.followup_notes,
    f.followup_date,
    f.next_followup_date,
    g.gift_name,
    g.quantity,
    g.given_date
   FROM (((ai_recommendations a
     LEFT JOIN customers c ON ((a.customer_id = c."Id")))
     LEFT JOIN LATERAL ( SELECT followups."Id",
            followups.customer_name,
            followups.followup_notes,
            followups.followup_date,
            followups.next_followup_date,
            followups.next_followup_goal,
            followups.customer_id,
            followups.created_at
           FROM followups
          WHERE (followups.customer_id = a.customer_id)
          ORDER BY followups.created_at DESC
         LIMIT 1) f ON (true))
     LEFT JOIN LATERAL ( SELECT gifts."Id",
            gifts.customer_name,
            gifts.gift_name,
            gifts.quantity,
            gifts.notes,
            gifts.given_date,
            gifts.customer_id,
            gifts.created_at
           FROM gifts
          WHERE (gifts.customer_id = a.customer_id)
          ORDER BY gifts.created_at DESC
         LIMIT 1) g ON (true));

COMMENT ON VIEW public.ai_recommendations_view IS
  'AI建议视图（20260907090000 重建：补 nba 列，随基表 ai_recommendations）';

-- 3) DROP 后授权丢失，按原授权恢复（anon 原本无本视图授权，保持不变）
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.ai_recommendations_view TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.ai_recommendations_view TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.ai_recommendations_view TO cloudbase_postgres_pgdb_pn3idppt;
