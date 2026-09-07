-- 20260907204000: 新建客户经营机会表（v1.2.1）
-- 轻量机会跟踪：只存机会状态，不复制客户资料（客户资料仍在 customers/profile/followups）
-- 机会类型：医疗保障/重疾保障/养老规划/教育规划/财富规划/家庭保障/转介绍
-- 机会状态：发现/沟通/方案/成交/关闭
CREATE TABLE IF NOT EXISTS opportunities (
    id                bigserial PRIMARY KEY,
    customer_id       integer     NOT NULL,                -- 软关联 customers.Id
    opportunity_type  text        NOT NULL,                -- 机会类型（7 种枚举）
    status            text        NOT NULL DEFAULT '发现', -- 机会状态（5 种枚举）
    discovered_at     date,                                -- 发现日期（默认当天）
    last_progress     text,                                -- 最近进展（1-2 句）
    next_action       text,                                -- 下一步动作
    ai_summary        text,                                -- AI 识别理由（仅 AI 建议→用户确认创建时填）
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    deleted_at        timestamptz                          -- 软删除（对齐全库基线）
);

CREATE INDEX IF NOT EXISTS idx_opportunities_customer
    ON opportunities (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_opportunities_status
    ON opportunities (status) WHERE deleted_at IS NULL;

COMMENT ON TABLE  opportunities                  IS '客户经营机会表（轻量：只存机会状态，不复制客户资料）';
COMMENT ON COLUMN opportunities.opportunity_type IS '机会类型：医疗保障/重疾保障/养老规划/教育规划/财富规划/家庭保障/转介绍';
COMMENT ON COLUMN opportunities.status           IS '机会状态：发现/沟通/方案/成交/关闭';
COMMENT ON COLUMN opportunities.ai_summary       IS 'AI 识别理由摘要（仅 AI 建议→用户确认创建时填写）';

-- RLS 基线：fn_only（仅云函数匿名上下文可访问，与 customers_fn_only 同款）
ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;
CREATE POLICY opportunities_fn_only ON public.opportunities
  FOR ALL TO anon
  USING ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text))
  WITH CHECK ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text));

-- 授权对齐 followups：anon 无 TRUNCATE；服务角色全量
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.opportunities TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.opportunities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.opportunities TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.opportunities TO cloudbase_postgres_pgdb_pn3idppt;
GRANT USAGE, SELECT ON SEQUENCE opportunities_id_seq TO anon, authenticated;
