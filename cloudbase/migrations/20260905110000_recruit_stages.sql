-- 20260905110000: 增员阶段流程改版
-- 新阶段：新增人才/接触中/初步面谈/详细面谈/线下活动/入职申请/签约入司
-- 旧→新映射：名单→新增人才, 接触→接触中, 面谈1→初步面谈, 面谈2→详细面谈,
--            创说会→线下活动, 报考→入职申请, 入司/转正→签约入司

ALTER TABLE public.recruit_candidates ALTER COLUMN stage SET DEFAULT '新增人才';

UPDATE public.recruit_candidates SET stage='新增人才' WHERE stage='名单';
UPDATE public.recruit_candidates SET stage='接触中'  WHERE stage='接触';
UPDATE public.recruit_candidates SET stage='初步面谈' WHERE stage='面谈1';
UPDATE public.recruit_candidates SET stage='详细面谈' WHERE stage='面谈2';
UPDATE public.recruit_candidates SET stage='线下活动' WHERE stage='创说会';
UPDATE public.recruit_candidates SET stage='入职申请' WHERE stage='报考';
UPDATE public.recruit_candidates SET stage='签约入司' WHERE stage IN ('入司','转正');
