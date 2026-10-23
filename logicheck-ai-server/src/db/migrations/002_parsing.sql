/* ============================================================
   002 · 单证解析流水线（阶段二）

   - extracted_fields：保存标准化值、来源位置（页码/偏移）、置信度与提取状态
   - documents：解析产物摘要（可解释、可追溯）
   既有数据全部保留（仅新增列，带默认值）。
   ============================================================ */

ALTER TABLE extracted_fields ADD COLUMN normalized_value TEXT;
ALTER TABLE extracted_fields ADD COLUMN page INTEGER;
ALTER TABLE extracted_fields ADD COLUMN position TEXT;
ALTER TABLE extracted_fields ADD COLUMN confidence REAL;
ALTER TABLE extracted_fields ADD COLUMN status TEXT NOT NULL DEFAULT 'extracted';

ALTER TABLE documents ADD COLUMN parse_summary TEXT;
