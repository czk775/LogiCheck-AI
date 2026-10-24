/* ============================================================
   004_ai：真实 AI 提取与视觉 OCR（第五阶段）

   - extracted_fields.evidence_quote：AI 提取字段的原文证据片段
     （模型给出的引用，且已被服务端核验确实存在于该页文本中）
   - extracted_fields.extraction_model：产出该字段的模型名（可追溯到具体模型）
   - documents.extraction_provider / extraction_model：单证级来源记录
   既有数据全部保留（仅新增列，带默认值）。
   ============================================================ */

ALTER TABLE extracted_fields ADD COLUMN evidence_quote TEXT;
ALTER TABLE extracted_fields ADD COLUMN extraction_model TEXT;

ALTER TABLE documents ADD COLUMN extraction_provider TEXT;
ALTER TABLE documents ADD COLUMN extraction_model TEXT;
