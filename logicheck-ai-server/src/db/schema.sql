/* ============================================================
   LogiCheck AI · 数据库 Schema（PRD v2.0 §9.1 最小数据实体）

   实体覆盖：User / Shipment / Document(version, owner, storageKey) /
   ExtractedField / ShipmentFieldCandidate / Finding / ComplianceRule /
   CheckResult / ProcessingRun / HumanDecision / AuditEvent(activities)。
   所有用户数据表均带 user_id（直接或经 shipment 关联），支持 ownerId 严格授权。

   第一阶段实现范围：users / sessions / password_resets / shipments /
   documents / extracted_fields / findings / human_decisions /
   processing_runs / activities。
   - extracted_fields / findings / runs 等 AI 相关写入能力属后续阶段；
     本阶段由演示 seed 与确定性演示逻辑使用，不接入真实 AI。
   ============================================================ */

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  is_demo       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shipments (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  origin       TEXT NOT NULL DEFAULT '待提取',
  destination  TEXT NOT NULL DEFAULT '待提取',
  is_demo      INTEGER NOT NULL DEFAULT 0,
  dirty        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shipments_user ON shipments(user_id);

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  shipment_id  TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name    TEXT NOT NULL,
  doc_type     TEXT NOT NULL DEFAULT '待 AI 识别',
  format       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'uploading',
  size         INTEGER NOT NULL DEFAULT 0,
  storage_key  TEXT,
  error        TEXT,
  is_demo      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_shipment ON documents(shipment_id);

CREATE TABLE IF NOT EXISTS extracted_fields (
  id               TEXT PRIMARY KEY,
  document_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  shipment_id      TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  field_key        TEXT NOT NULL,
  value            TEXT NOT NULL,
  original_value   TEXT,
  source           TEXT NOT NULL DEFAULT 'ai',
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fields_document ON extracted_fields(document_id);

CREATE TABLE IF NOT EXISTS shipment_profiles (
  shipment_id  TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  field_key    TEXT NOT NULL,
  value        TEXT NOT NULL,
  PRIMARY KEY (shipment_id, field_key)
);

CREATE TABLE IF NOT EXISTS findings (
  id           TEXT PRIMARY KEY,
  shipment_id  TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  rule_key     TEXT,
  severity     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  summary      TEXT NOT NULL,
  evidence     TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_shipment ON findings(shipment_id);

CREATE TABLE IF NOT EXISTS human_decisions (
  id           TEXT PRIMARY KEY,
  finding_id   TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  shipment_id  TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'review',
  at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processing_runs (
  id            TEXT PRIMARY KEY,
  shipment_id   TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  trigger       TEXT NOT NULL,
  status        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  summary       TEXT NOT NULL,
  rule_version  TEXT,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS activities (
  id           TEXT PRIMARY KEY,
  shipment_id  TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_shipment ON activities(shipment_id);

/* 合规规则参考数据（PRD §7.1 Rule Contract；全局共享，无 owner） */
CREATE TABLE IF NOT EXISTS compliance_rules (
  rule_id          TEXT PRIMARY KEY,
  key              TEXT NOT NULL UNIQUE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  title            TEXT NOT NULL,
  category         TEXT NOT NULL,
  jurisdiction     TEXT NOT NULL,
  product_scope    TEXT NOT NULL,
  actor_scope      TEXT NOT NULL,
  effective_from   TEXT NOT NULL,
  effective_to     TEXT,
  trigger          TEXT NOT NULL,
  required_evidence TEXT NOT NULL DEFAULT '[]',
  check_logic      TEXT NOT NULL,
  severity         TEXT NOT NULL,
  source_title     TEXT NOT NULL,
  source_url       TEXT NOT NULL,
  source_version   TEXT NOT NULL,
  accessed_at      TEXT NOT NULL,
  rule_version     TEXT NOT NULL,
  detail           TEXT NOT NULL,
  recommend        TEXT NOT NULL
);

/* 规则预检结果（演示货物由内置示例数据填充；真实检查属后续阶段） */
CREATE TABLE IF NOT EXISTS check_results (
  id            TEXT PRIMARY KEY,
  shipment_id   TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  rule_key      TEXT NOT NULL,
  status        TEXT NOT NULL,
  label         TEXT NOT NULL,
  tone          TEXT NOT NULL,
  evidence_refs TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_check_results_shipment ON check_results(shipment_id);
