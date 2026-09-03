-- 20260904110000: 给 recruit_candidates / recruit_milestones 表和序列授权给 anon/authenticated
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE ON TABLE recruit_candidates TO anon;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE ON TABLE recruit_candidates TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE ON TABLE recruit_milestones TO anon;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE ON TABLE recruit_milestones TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE recruit_candidates_id_seq TO anon;
GRANT USAGE, SELECT ON SEQUENCE recruit_candidates_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE recruit_milestones_id_seq TO anon;
GRANT USAGE, SELECT ON SEQUENCE recruit_milestones_id_seq TO authenticated;
