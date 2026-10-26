/* 005：单账号每日 AI 解析用量（公网防滥用配额，跨天按 day 维度自然重置） */
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  user_id    TEXT NOT NULL,
  day        TEXT NOT NULL,
  parses     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
)
