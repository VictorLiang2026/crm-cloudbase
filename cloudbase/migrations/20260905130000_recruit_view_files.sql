-- 20260905130000: 增员视图补充评估附件列
-- 背景：20260905120000 给 recruit_candidates 表增加了雷达图/报告 4 个附件列，
-- 但视图 v_recruit_candidates 未同步重建（PostgreSQL 视图不会自动包含后加列），
-- 导致云函数 list/get 经 SELECT * 读不到 radar_*/winner_* 字段，
-- 前端候选人详情页「评估附件」始终显示“未上传”，上传后也无法回显。
-- 处理：DROP 重建视图（无其他数据库对象依赖该视图），补齐附件列并重新授权。

DROP VIEW IF EXISTS public.v_recruit_candidates;

CREATE VIEW public.v_recruit_candidates AS
SELECT rc.id                        AS candidate_id,
       rc.customer_id,
       c.customer_name,
       c.gender,
       c.birthday,
       c.phone,
       c.wx_account,
       c.occupation,
       c.annual_income,
       c.education,
       c.mbti,
       c.source,
       c.marital_status,
       c.hobbies,
       c.additional_info,
       rc.recommender_id,
       rc.stage,
       rc.stage_changed_at,
       rc.potential_score,
       rc.potential_reason,
       rc.motivation,
       rc.concerns,
       rc.work_experience,
       rc.family_situation,
       rc.personality_tags,
       rc.career_plan,
       rc.next_action_date,
       rc.next_action,
       rc.activity_history,
       rc.radar_image_file_id,
       rc.radar_image_name,
       rc.winner_report_file_id,
       rc.winner_report_name,
       rc.operator,
       rc.created_at,
       rc.updated_at,
       CASE WHEN rc.stage_changed_at IS NOT NULL
            THEN EXTRACT(DAY FROM now() - rc.stage_changed_at)::integer
            ELSE NULL END AS idle_days
FROM public.recruit_candidates rc
JOIN public.customers c ON c."Id" = rc.customer_id
WHERE rc.deleted_at IS NULL
  AND c.deleted_at IS NULL;

COMMENT ON VIEW public.v_recruit_candidates IS '增员候选人完整视图（JOIN customers，含评估附件字段）';

GRANT SELECT ON public.v_recruit_candidates TO anon, authenticated, service_role;
