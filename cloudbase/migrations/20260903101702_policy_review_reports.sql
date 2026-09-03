-- 20260903101702: 新建保单检视报告表 policy_review_reports
-- 设计原则：生成字段(summary/gaps_found/recommendations/asset_allocation/next_action)
--         与人工编辑字段(edited_*) 分离双写，互不覆盖，展示时优先 edited_*（若非空）
CREATE TABLE IF NOT EXISTS policy_review_reports (
    id                      bigserial PRIMARY KEY,
    customer_id             bigint      NOT NULL,
    customer_name           text,
    report_date             date        NOT NULL DEFAULT (CURRENT_DATE),
    report_type             text        NOT NULL DEFAULT '保单年度检视',
    gaps_found              text,
    recommendations         text,
    asset_allocation        text,
    next_action             text,
    summary                 text,
    raw                     text,
    edited_summary          text,
    edited_gaps             text,
    edited_recommendations  text,
    edited_asset_allocation text,
    edited_next_action      text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_policy_review_reports_customer_id
    ON policy_review_reports (customer_id);

CREATE INDEX IF NOT EXISTS idx_policy_review_reports_date
    ON policy_review_reports (report_date DESC, id DESC);

COMMENT ON TABLE  policy_review_reports                   IS '保单检视报告（每客户可生成多份，按时间倒序）';
COMMENT ON COLUMN policy_review_reports.summary           IS '综合摘要（AI生成）';
COMMENT ON COLUMN policy_review_reports.gaps_found        IS '保障缺口/问题识别（AI生成）';
COMMENT ON COLUMN policy_review_reports.recommendations   IS '检视建议（AI生成，多条）';
COMMENT ON COLUMN policy_review_reports.asset_allocation  IS '资产配置/保费结构优化建议（AI生成）';
COMMENT ON COLUMN policy_review_reports.next_action       IS '下一步行动/约访建议（AI生成）';
COMMENT ON COLUMN policy_review_reports.raw               IS '模型原始输出（排障）';
COMMENT ON COLUMN policy_review_reports.edited_summary    IS '人工编辑后的摘要（非空则在前端优先展示）';
COMMENT ON COLUMN policy_review_reports.edited_gaps       IS '人工编辑后的缺口';
COMMENT ON COLUMN policy_review_reports.edited_recommendations  IS '人工编辑后的建议';
COMMENT ON COLUMN policy_review_reports.edited_asset_allocation IS '人工编辑后的资产配置';
COMMENT ON COLUMN policy_review_reports.edited_next_action      IS '人工编辑后的下一步';
