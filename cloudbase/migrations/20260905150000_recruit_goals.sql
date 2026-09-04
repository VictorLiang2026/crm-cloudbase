-- 20260905150000: 增员目标管理 + 行业基准
-- 借鉴国际保险行业增员 KPI 体系（友邦「最优秀代理」模式 + LIMRA 漏斗基准 + CareerPlug/Gem 招聘漏斗报告）
-- 三层 KPI：活动量（7阶段目标）→ 阶段转化率 → 结果产出（签约达成）
-- 基准数据可修改，预置友邦及行业参考值

-- ===== 增员月度目标表 =====
CREATE TABLE IF NOT EXISTS recruit_goals (
    id              bigserial PRIMARY KEY,
    goal_month      date        NOT NULL,               -- 目标月份（每月1日，如 2026-09-01）
    stage           text        NOT NULL,               -- 阶段名（7阶段之一）
    target_count    integer     NOT NULL DEFAULT 0,     -- 该阶段当月目标数量
    note            text,                               -- 备注
    operator        text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE(goal_month, stage)                          -- 同月同阶段唯一
);

CREATE INDEX IF NOT EXISTS idx_recruit_goals_month
    ON recruit_goals (goal_month);
CREATE INDEX IF NOT EXISTS idx_recruit_goals_stage
    ON recruit_goals (stage);

COMMENT ON TABLE  recruit_goals             IS '增员月度目标表（按月按阶段设定目标数量）';
COMMENT ON COLUMN recruit_goals.goal_month  IS '目标月份（存每月1日）';
COMMENT ON COLUMN recruit_goals.stage       IS '增员7阶段之一：新增人才/接触中/初步面谈/详细面谈/线下活动/入职申请/签约入司';
COMMENT ON COLUMN recruit_goals.target_count IS '该阶段当月目标数量';

-- ===== 行业基准数据表（可修改） =====
CREATE TABLE IF NOT EXISTS recruit_goal_benchmarks (
    id              bigserial PRIMARY KEY,
    stage_from      text NOT NULL,                      -- 起始阶段（上游）
    stage_to        text NOT NULL,                      -- 目标阶段（下游）
    conversion_min  numeric(5,2) NOT NULL,              -- 最低转化率%（红色预警线）
    conversion_avg  numeric(5,2) NOT NULL,              -- 行业平均转化率%（黄色参考线）
    conversion_good numeric(5,2) NOT NULL,              -- 优秀转化率%（绿色标杆线）
    source          text,                               -- 数据来源
    note            text,                               -- 说明
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE(stage_from, stage_to)
);

COMMENT ON TABLE  recruit_goal_benchmarks                IS '增员漏斗行业基准（可修改）';
COMMENT ON COLUMN recruit_goal_benchmarks.conversion_min  IS '最低转化率%（低于此值红色预警）';
COMMENT ON COLUMN recruit_goal_benchmarks.conversion_avg  IS '行业平均转化率%（黄色参考线）';
COMMENT ON COLUMN recruit_goal_benchmarks.conversion_good IS '优秀转化率%（绿色标杆线）';

-- ===== 预置行业基准数据 =====
-- 数据来源：友邦2024年报 + LIMRA + CareerPlug 2025(1000万+申请) + Gem 2026 + CleanLeads 365 + insurance-os-master
INSERT INTO recruit_goal_benchmarks (stage_from, stage_to, conversion_min, conversion_avg, conversion_good, source, note) VALUES
('新增人才', '接触中',     15.00, 25.00, 35.00, 'CareerPlug申请→筛选25%; 保险增员接触率偏低', '接触率：新增后成功建立有效接触的比例'),
('接触中',   '初步面谈',   15.00, 20.00, 30.00, 'LIMRA保险接触→约面率20-35%; CleanLeads 20-35%', '约面率：接触后成功安排初步面谈的比例'),
('初步面谈', '详细面谈',   30.00, 40.00, 55.00, 'CareerPlug初面→深面40-60%; 保险面谈深化率', '深化率：初面后进入详细面谈的比例'),
('详细面谈', '线下活动',   30.00, 45.00, 60.00, '保险行业深面→活动转化; avua面谈→评估40-60%', '活动转化率：深面后参加线下活动的比例'),
('线下活动', '入职申请',   40.00, 55.00, 70.00, '保险行业活动→入职申请; offer发放率50-70%', '申请率：线下活动后提交入职申请的比例'),
('入职申请', '签约入司',   65.00, 75.00, 85.00, 'CareerPlug offer接受率63%+; 保险行业75-85%', '签约率：入职申请后正式签约的比例'),
('新增人才', '签约入司',   1.50,  3.00,  5.00,  'CleanLeads保险整体1.5-5%; CareerPlug 0.5-3%', '整体漏斗转化率：新增到最终签约')
ON CONFLICT (stage_from, stage_to) DO NOTHING;

-- ===== 授权 =====
GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE recruit_goals TO anon;
GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE recruit_goals TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE recruit_goals_id_seq TO anon;
GRANT USAGE, SELECT ON SEQUENCE recruit_goals_id_seq TO authenticated;

GRANT SELECT, UPDATE ON TABLE recruit_goal_benchmarks TO anon;
GRANT SELECT, UPDATE ON TABLE recruit_goal_benchmarks TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE recruit_goal_benchmarks_id_seq TO anon;
GRANT USAGE, SELECT ON SEQUENCE recruit_goal_benchmarks_id_seq TO authenticated;
