/* ============================================================
   003_checking：核验引擎（阶段三）
   - check_results.reasoning：规则判定依据（可解释）
   - findings.check_key：引擎管理项的自然键（cross:<字段> / rule:<规则>），
     供重跑时定位同一检查项；演示货物既有异常（check_key 为空）不受影响
   ============================================================ */

ALTER TABLE check_results ADD COLUMN reasoning TEXT;
ALTER TABLE findings ADD COLUMN check_key TEXT;
CREATE INDEX IF NOT EXISTS idx_findings_check_key ON findings(shipment_id, check_key);
