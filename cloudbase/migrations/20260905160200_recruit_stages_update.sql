-- 20260905160200: 增员阶段名称调整 + 行业基准数据更新
-- 旧阶段 → 新阶段映射：
--   接触中   → 互动暖客
--   初步面谈 → 初次面谈
--   详细面谈 → 精准面谈
--   线下活动 → 增员活动
--   新增人才 / 入职申请 / 签约入司 不变

-- ===== 1. 更新候选人表中的旧阶段名 =====
UPDATE recruit_candidates SET stage = '互动暖客' WHERE stage = '接触中';
UPDATE recruit_candidates SET stage = '初次面谈' WHERE stage = '初步面谈';
UPDATE recruit_candidates SET stage = '精准面谈' WHERE stage = '详细面谈';
UPDATE recruit_candidates SET stage = '增员活动' WHERE stage = '线下活动';

-- ===== 2. 更新里程碑表中的旧阶段名 =====
UPDATE recruit_milestones SET from_stage = '互动暖客' WHERE from_stage = '接触中';
UPDATE recruit_milestones SET from_stage = '初次面谈' WHERE from_stage = '初步面谈';
UPDATE recruit_milestones SET from_stage = '精准面谈' WHERE from_stage = '详细面谈';
UPDATE recruit_milestones SET from_stage = '增员活动' WHERE from_stage = '线下活动';

UPDATE recruit_milestones SET to_stage = '互动暖客' WHERE to_stage = '接触中';
UPDATE recruit_milestones SET to_stage = '初次面谈' WHERE to_stage = '初步面谈';
UPDATE recruit_milestones SET to_stage = '精准面谈' WHERE to_stage = '详细面谈';
UPDATE recruit_milestones SET to_stage = '增员活动' WHERE to_stage = '线下活动';

-- ===== 3. 重建行业基准数据（新阶段名 + 友邦参考） =====
DELETE FROM recruit_goal_benchmarks;

-- 新阶段：新增人才 → 互动暖客 → 初次面谈 → 增员活动 → 精准面谈 → 入职申请 → 签约入司
-- 数据来源：友邦2024年报 + LIMRA + CareerPlug 2025 + Gem 2026 + CleanLeads 365 + 保险行业增员漏斗模型
INSERT INTO recruit_goal_benchmarks (stage_from, stage_to, conversion_min, conversion_avg, conversion_good, source, note) VALUES
('新增人才', '互动暖客',  15.00, 25.00, 35.00,
 '友邦年招募18%; CareerPlug申请筛选25%; LIMRA接触率20-35%',
 '暖客率：新增名单后成功建立有效互动（电话/微信/社交）的比例。友邦精英团队通过MDRT转介绍体系可达35%+'),

('互动暖客', '初次面谈',  15.00, 20.00, 30.00,
 'LIMRA保险接触约面率20-35%; CleanLeads 20-35%; 友邦通过暖客活动提升约面率',
 '约面率：互动暖客后成功安排初次面谈的比例。友邦通过创说会/事业说明会提升此环节转化'),

('初次面谈', '增员活动',  30.00, 45.00, 60.00,
 'CareerPlug初面深面40-60%; 友邦创说会出席率50-60%; 保险行业初次面谈活动转化',
 '活动参与率：初次面谈后参加增员活动（创说会/事业体验日）的比例。友邦模式中创说会是关键转化节点'),

('增员活动', '精准面谈',  30.00, 45.00, 60.00,
 '保险行业活动深度面谈40-60%; 友邦活动后精准面谈安排率; avua面谈评估40-60%',
 '深面安排率：增员活动后进入精准面谈（一对一深度沟通）的比例。友邦精英团队活动后跟进率较高'),

('精准面谈', '入职申请',  40.00, 55.00, 70.00,
 '保险行业深面入职申请; CareerPlug offer发放率50-70%; 友邦精准面谈后入职申请提交率',
 '申请提交率：精准面谈后正式提交入职申请的比例。友邦1年留存30%但入职前筛选严格'),

('入职申请', '签约入司',  65.00, 75.00, 85.00,
 'CareerPlug offer接受率63%+; 保险行业75-85%; 友邦活动人力增长9%',
 '签约率：入职申请后正式签约入司的比例。友邦活动人力增长+9%（2024年报），反映此环节转化稳定'),

('新增人才', '签约入司',  1.50,  3.00,  5.00,
 'CleanLeads保险整体1.5-5%; CareerPlug 0.5-3%; 友邦年招募18%但1年留存30%',
 '整体漏斗转化率：从新增名单到最终签约的全链路转化。友邦高招募量（+18%）弥补高流失（1年留存30%）')
ON CONFLICT (stage_from, stage_to) DO NOTHING;
