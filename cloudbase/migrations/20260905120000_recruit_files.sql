-- 20260905120000: 增员候选人增加文件附件字段
-- 竞争力评估雷达图（图片）+ 天生赢家报告（文档）
-- 文件实体存云存储 recruit/{candidate_id}/ 目录，表中存 fileID + 原文件名

ALTER TABLE public.recruit_candidates ADD COLUMN IF NOT EXISTS radar_image_file_id  text;
ALTER TABLE public.recruit_candidates ADD COLUMN IF NOT EXISTS radar_image_name     text;
ALTER TABLE public.recruit_candidates ADD COLUMN IF NOT EXISTS winner_report_file_id text;
ALTER TABLE public.recruit_candidates ADD COLUMN IF NOT EXISTS winner_report_name   text;

COMMENT ON COLUMN public.recruit_candidates.radar_image_file_id  IS '竞争力评估雷达图 云存储fileID';
COMMENT ON COLUMN public.recruit_candidates.radar_image_name     IS '竞争力评估雷达图 原文件名';
COMMENT ON COLUMN public.recruit_candidates.winner_report_file_id IS '天生赢家报告 云存储fileID';
COMMENT ON COLUMN public.recruit_candidates.winner_report_name   IS '天生赢家报告 原文件名';

GRANT UPDATE (radar_image_file_id, radar_image_name, winner_report_file_id, winner_report_name)
ON public.recruit_candidates TO anon, authenticated, service_role;
