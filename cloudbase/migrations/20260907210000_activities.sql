-- 20260907210000: 轻量活动经营（v1.3）
-- 活动作为获客/关系经营/增员/转介绍的数据入口，不是活动管理系统
-- 两层结构：activities（活动） + activity_participants（参与人，多态 person_type）

CREATE TABLE IF NOT EXISTS activities (
    id            bigserial PRIMARY KEY,
    name          text        NOT NULL,
    activity_date date,
    activity_type text,
    location      text,
    description   text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_activities_date
    ON activities (activity_date) WHERE deleted_at IS NULL;

COMMENT ON TABLE activities IS '轻量活动表（活动经营的入口，不含报名/签到/票务）';

-- 参与者：多态关联 customer / recruit_candidates，不建统一 Person 表
CREATE TABLE IF NOT EXISTS activity_participants (
    id                   bigserial PRIMARY KEY,
    activity_id          integer     NOT NULL,
    person_type          text        NOT NULL,  -- customer | recruit
    person_id            integer     NOT NULL,
    status               text        NOT NULL DEFAULT 'invited',  -- invited | attended | absent
    relationship_note    text,
    ai_followup_suggestion text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    deleted_at           timestamptz
);

CREATE INDEX IF NOT EXISTS idx_participants_activity
    ON activity_participants (activity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_participants_person
    ON activity_participants (person_type, person_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE activity_participants IS '活动参与者（多态：customer/recruit，不建统一 Person 表）';
COMMENT ON COLUMN activity_participants.person_type IS 'customer 或 recruit';
COMMENT ON COLUMN activity_participants.status IS 'invited(邀请) | attended(参加) | absent(缺席)';
COMMENT ON COLUMN activity_participants.ai_followup_suggestion IS 'AI 生成的跟进建议（活动后分析）';

-- RLS：fn_only（与 opportunities/customers 同款）
ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY activities_fn_only ON public.activities
  FOR ALL TO anon
  USING ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text))
  WITH CHECK ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text));

ALTER TABLE public.activity_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY activity_participants_fn_only ON public.activity_participants
  FOR ALL TO anon
  USING ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text))
  WITH CHECK ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text));

-- 授权（对齐 followups/opportunities）
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.activities TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.activities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.activities TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.activities TO cloudbase_postgres_pgdb_pn3idppt;
GRANT USAGE, SELECT ON SEQUENCE activities_id_seq TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.activity_participants TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.activity_participants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.activity_participants TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.activity_participants TO cloudbase_postgres_pgdb_pn3idppt;
GRANT USAGE, SELECT ON SEQUENCE activity_participants_id_seq TO anon, authenticated;
