-- 20260907223000: 活动参与者支持"按姓名暂存，后续关联"（v1.3.1）
-- 添加参与者不再要求输入 ID：输入姓名搜索，匹配则关联；未匹配先暂存 person_name，person_id 置空待后续关联。
ALTER TABLE activity_participants ADD COLUMN IF NOT EXISTS person_name text;
ALTER TABLE activity_participants ALTER COLUMN person_id DROP NOT NULL;
COMMENT ON COLUMN activity_participants.person_name IS '参与者姓名（未关联时暂存，关联后回填客户/增员姓名）';
