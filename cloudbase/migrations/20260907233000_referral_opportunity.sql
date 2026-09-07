-- 20260907233000: 轻量转介绍经营（v1.4.0）
-- 复用经营机会（opportunities）承载转介绍线索，不改客户表、不建 Referral 模块：
--   opportunity_type='转介绍' 的记录即一条转介绍线索，customer_id = 来源客户；
--   转介绍专属状态机复用 status 列（潜在线索/已介绍/已联系/已建立关系/成交/关闭，云函数按类型校验）；
--   被介绍人姓名、与来源客户关系新增两列；"下一步"复用 next_action。
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS referred_name text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS referred_relation text;
COMMENT ON COLUMN opportunities.referred_name IS '被介绍人姓名（转介绍线索）';
COMMENT ON COLUMN opportunities.referred_relation IS '被介绍人与来源客户的关系（如朋友/同事/亲戚）';
