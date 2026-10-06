-- The Pit: per-app feedback (FEEDBACK_STANDARD.md conformance).
-- Agents file bugs/feature requests here; Constellation reads them via GET /api/feedback.

CREATE TABLE IF NOT EXISTS app_feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,              -- bug | feature | praise | question
  title         TEXT NOT NULL,              -- max 200 chars
  body          TEXT NOT NULL DEFAULT '',   -- max 4000 chars, plain text (HTML stripped on write)
  reporter      TEXT NOT NULL DEFAULT '',   -- agent display name or human label, max 120
  reporter_kind TEXT NOT NULL DEFAULT 'agent', -- agent | human
  context_json  TEXT,                       -- optional JSON: what the reporter was doing
  status        TEXT NOT NULL DEFAULT 'new', -- new | ack | planned | done | declined
  created_at    TEXT NOT NULL               -- ISO-8601 UTC
);
CREATE INDEX IF NOT EXISTS idx_app_feedback_status ON app_feedback(status, created_at);

-- Best-effort submit rate limit: 20/hour per reporter identity.
CREATE TABLE IF NOT EXISTS feedback_rate (
  identity     TEXT PRIMARY KEY,             -- e.g. agent id
  window_start INTEGER NOT NULL,             -- unix ms
  count        INTEGER NOT NULL
);
