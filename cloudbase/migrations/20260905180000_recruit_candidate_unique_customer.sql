-- ============================================================
-- 增员候选人 customer_id 局部唯一索引
-- 背景: 客户列表「增员状态」列依赖"同一客户至多一条未删除候选人记录"的
--       一对一关系（派生状态, 不在 customers 表存状态字段）。
-- 内容: 1. 删除原普通索引 idx_recruit_candidates_customer（被唯一索引取代）
--       2. 创建局部唯一索引: 未删除记录中 customer_id 唯一
--          （允许软删除后重新增员同一客户）
-- 注: 执行前已核实存量数据无重复。经 execute(allowDdlViaExecute) 执行。
-- ============================================================

DROP INDEX IF EXISTS public.idx_recruit_candidates_customer;

CREATE UNIQUE INDEX IF NOT EXISTS uq_recruit_candidates_customer_active
  ON public.recruit_candidates (customer_id)
  WHERE deleted_at IS NULL;
