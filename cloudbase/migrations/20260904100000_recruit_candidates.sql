-- 20260904100000: 新建增员候选人表 + 阶段里程碑事件表
-- 候选人与 customers 通过 customer_id 软关联（一个人可同时是客户和候选人）
-- 阶段枚举：名单/接触/面谈1/面谈2/创说会/报考/入司/转正/流失
CREATE TABLE IF NOT EXISTS recruit_candidates (
    id                  bigserial PRIMARY KEY,
    customer_id         bigint,                         -- 软关联 customers.Id
    name                text        NOT NULL,
    gender              text,
    birthday            text,
    phone               text,
    wechat              text,
    occupation          text,                           -- 现职/行业
    annual_income       text,                           -- 年收入区间
    education           text,                           -- 学历
    mbti                text,                           -- MBTI 16型
    motivation          text,                           -- 求职动机
    concerns            text,                           -- 顾虑点
    source              text,                           -- 来源：转介绍/客户转化/招聘平台/社区/校友会/亲属/其他
    recommender_id      bigint,                         -- 推荐人（指向另一候选人或 customers.Id）
    stage               text        NOT NULL DEFAULT '名单',
    stage_changed_at    timestamptz,                    -- 阶段变更时间（用于停滞预警）
    potential_score     integer,                        -- AI 高潜评分 0-100
    potential_reason    text,                           -- AI 评分理由
    notes               text,                           -- 备注
    operator            text,                           -- 操作员
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_recruit_candidates_stage
    ON recruit_candidates (stage) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recruit_candidates_customer
    ON recruit_candidates (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recruit_candidates_recommender
    ON recruit_candidates (recommender_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE  recruit_candidates                  IS '增员候选人表（与 customers 软关联）';
COMMENT ON COLUMN recruit_candidates.stage            IS '阶段：名单/接触/面谈1/面谈2/创说会/报考/入司/转正/流失';
COMMENT ON COLUMN recruit_candidates.potential_score  IS 'AI 高潜评分 0-100（recruit_score 云函数生成）';
COMMENT ON COLUMN recruit_candidates.mbti             IS 'MBTI 16型枚举（用于 AI 陪练话术生成）';

-- 阶段里程碑事件表（记录每次阶段变更，形成候选人时间线）
CREATE TABLE IF NOT EXISTS recruit_milestones (
    id              bigserial PRIMARY KEY,
    candidate_id    bigint      NOT NULL,
    from_stage      text,
    to_stage        text        NOT NULL,
    happened_at     timestamptz NOT NULL DEFAULT now(),
    note            text,
    operator        text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recruit_milestones_candidate
    ON recruit_milestones (candidate_id);

COMMENT ON TABLE recruit_milestones IS '增员阶段里程碑事件表（候选人时间线）';
