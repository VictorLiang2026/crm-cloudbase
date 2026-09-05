-- ============================================================
-- ocr_records 表安全基线对齐（对齐 customers 基线）
-- ocr_records 存储证件/名片 OCR 识别结果（含身份证等敏感信息），
-- 原先 RLS 未启用，为全库最敏感的未防护表。
-- 内容: ENABLE ROW LEVEL SECURITY + fn_only 策略
--       （仅云函数匿名上下文可访问，与 customers_fn_only 逐字一致）
-- GRANT 已与基线一致（anon: SELECT/INSERT/UPDATE/DELETE），无需调整。
-- 注: 因 CloudBase 迁移 API 名称校验异常，经 execute(allowDdlViaExecute) 执行。
-- ============================================================

ALTER TABLE public.ocr_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY ocr_records_fn_only ON public.ocr_records
  FOR ALL TO anon
  USING ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text))
  WITH CHECK ((((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text) IS NULL) AND (((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'anon'::text));
