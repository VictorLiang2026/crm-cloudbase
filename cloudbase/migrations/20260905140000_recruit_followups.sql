-- 20260905140000: 增员跟进记录表
-- 设计借鉴国际保险行业增员标准流程（Contact Log + Pipeline Activity）：
--   每次接触记录 = 接触方式 + 内容摘要 + 意向度评估 + 顾虑反馈 + 下一步行动
--   与 recruit_milestones（阶段流转，粗粒度）互补：跟进记录是细粒度接触日志
--   与 recruit_candidates.next_action_date/next_action（前瞻提醒）互补：跟进记录是回顾历史
-- 三层跟进体系：跟进记录（细）→ 里程碑（阶段流转）→ 下次行动（待办前瞻）

CREATE TABLE IF NOT EXISTS recruit_followups (
    id                  bigserial PRIMARY KEY,
    candidate_id        bigint      NOT NULL,               -- 关联 recruit_candidates.id
    contact_method      text,                               -- 接触方式：电话/微信/面谈/线下活动/邮件/其他
    followup_notes      text,                               -- 跟进内容（面谈要点、对方反馈等）
    followup_date       date        NOT NULL,               -- 本次跟进日期
    interest_level      text,                               -- 意向度评估：高/中/低/无（跟进后实时判断）
    concern_feedback    text,                               -- 顾虑变化记录（增员特有：薪酬顾虑/家庭反对/职业转型等）
    next_followup_date  date,                               -- 下次跟进日期
    next_followup_goal  text,                               -- 下次跟进目标
    operator            text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- 索引：按候选人查 + 按日期排序
CREATE INDEX IF NOT EXISTS idx_recruit_followups_candidate
    ON recruit_followups (candidate_id);
CREATE INDEX IF NOT EXISTS idx_recruit_followups_date
    ON recruit_followups (followup_date DESC);

COMMENT ON TABLE  recruit_followups               IS '增员跟进记录表（接触日志，与里程碑互补）';
COMMENT ON COLUMN recruit_followups.contact_method IS '接触方式：电话/微信/面谈/线下活动/邮件/其他';
COMMENT ON COLUMN recruit_followups.interest_level IS '意向度评估：高/中/低/无';
COMMENT ON COLUMN recruit_followups.concern_feedback IS '顾虑变化记录（增员场景特有）';

-- 授权（与 recruit_candidates / recruit_milestones 一致）
GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE recruit_followups TO anon;
GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE recruit_followups TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE recruit_followups_id_seq TO anon;
GRANT USAGE, SELECT ON SEQUENCE recruit_followups_id_seq TO authenticated;
