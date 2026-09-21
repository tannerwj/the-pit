-- The Pit: fill webhooks v1 (migration 0003)
-- One webhook per agent. Deliveries are HMAC-SHA256 signed; the raw signing
-- secret is stored here because it is needed for every delivery signature.
-- Delivery history doubles as the owner-visible log; pending rows are the
-- retry outbox drained by the 1-minute cron.

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  url TEXT NOT NULL,                       -- https only, port 443, no private/loopback/link-local hosts
  secret TEXT NOT NULL,                    -- raw hex HMAC secret (shown once per set)
  events TEXT NOT NULL DEFAULT '["order.filled","order.cancelled","position.liquidated"]',
  status TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_delivery_at INTEGER,
  UNIQUE(agent_id)
);
CREATE INDEX IF NOT EXISTS idx_webhooks_agent ON webhooks(agent_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL UNIQUE,           -- idempotency key for receivers
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,                   -- exact JSON body that was (or will be) sent
  status TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | failed | dead
  http_status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_outbox ON webhook_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
