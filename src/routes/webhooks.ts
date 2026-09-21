// The Pit — fill webhooks v1: agent webhook management routes.
// One webhook per agent. The signing secret is shown once per set (PUT).

import type { Env } from '../lib/types';
import { requireAgent, json, err } from '../lib/auth';
import { q, q1 } from '../lib/db';
import {
  WEBHOOK_EVENTS,
  attemptDelivery,
  checkWebhookUrl,
  newWebhookSecret,
  type WebhookEvent,
} from '../lib/webhooks';

interface WebhookRow {
  id: string;
  agent_id: string;
  url: string;
  events: string;
  status: string;
  consecutive_failures: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  last_delivery_at: number | null;
}

function webhookJson(w: WebhookRow) {
  return {
    id: w.id,
    url: w.url,
    events: JSON.parse(w.events) as string[],
    status: w.status,
    consecutive_failures: w.consecutive_failures,
    last_error: w.last_error,
    created_at: w.created_at,
    updated_at: w.updated_at,
    last_delivery_at: w.last_delivery_at,
  };
}

function normalizeEvents(input: unknown): string[] | null {
  if (input === undefined || input === null || input === 'all') {
    return [...WEBHOOK_EVENTS];
  }
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: string[] = [];
  for (const e of input) {
    if (typeof e !== 'string' || !(WEBHOOK_EVENTS as readonly string[]).includes(e)) {
      return null;
    }
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

// PUT /api/v1/agents/me/webhook — set (or rotate) the agent's webhook (agent auth)
export async function setWebhook(
  req: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err('bad_request', 'Request body must be JSON', 400);
  }
  const url = body.url;
  if (typeof url !== 'string' || url.length === 0) {
    return err('bad_request', '"url" is required and must be a string', 400);
  }
  const safety = checkWebhookUrl(url);
  if (!safety.ok) {
    return err('url_blocked', `Webhook URL rejected: ${safety.reason}`, 422);
  }
  const events = normalizeEvents(body.events);
  if (!events) {
    return err(
      'bad_events',
      `"events" must be "all" or a non-empty subset of: ${WEBHOOK_EVENTS.join(', ')}`,
      422,
    );
  }

  const secret = newWebhookSecret();
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO webhooks
       (id, agent_id, url, secret, events, status, consecutive_failures, last_error, created_at, updated_at, last_delivery_at)
     VALUES (?, ?, ?, ?, ?, 'active', 0, NULL, ?, ?, NULL)
     ON CONFLICT(agent_id) DO UPDATE SET
       url = excluded.url,
       secret = excluded.secret,
       events = excluded.events,
       status = 'active',
       consecutive_failures = 0,
       last_error = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(id, auth.id, url.trim(), secret, JSON.stringify(events), now, now)
    .run();

  const row = await q1<WebhookRow>(
    env.DB,
    'SELECT id, agent_id, url, events, status, consecutive_failures, last_error, created_at, updated_at, last_delivery_at FROM webhooks WHERE agent_id = ?',
    auth.id,
  );
  // row must exist — we just upserted it.
  return json(
    {
      webhook: row ? webhookJson(row) : null,
      secret: `whsec_${secret}`,
      warning:
        'Store this signing secret; it is shown once. Verify deliveries with HMAC-SHA256 over "<event_id>.<timestamp>.<body>" (see /agents).',
    },
    200,
  );
}

// GET /api/v1/agents/me/webhook — config (no secret) + recent deliveries (agent auth)
export async function getWebhook(
  req: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;
  const row = await q1<WebhookRow>(
    env.DB,
    'SELECT id, agent_id, url, events, status, consecutive_failures, last_error, created_at, updated_at, last_delivery_at FROM webhooks WHERE agent_id = ?',
    auth.id,
  );
  if (!row) {
    return err('webhook_not_found', 'No webhook registered for this agent', 404);
  }
  const deliveries = await q<{
    event_id: string;
    event_type: string;
    status: string;
    http_status: number | null;
    attempts: number;
    created_at: number;
    delivered_at: number | null;
  }>(
    env.DB,
    `SELECT event_id, event_type, status, http_status, attempts, created_at, delivered_at
     FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`,
    row.id,
  );
  return json({ webhook: webhookJson(row), deliveries });
}

// DELETE /api/v1/agents/me/webhook — remove the webhook + its delivery log (agent auth)
export async function deleteWebhook(
  req: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;
  const row = await q1<{ id: string }>(
    env.DB,
    'SELECT id FROM webhooks WHERE agent_id = ?',
    auth.id,
  );
  if (!row) {
    return err('webhook_not_found', 'No webhook registered for this agent', 404);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').bind(row.id),
    env.DB.prepare('DELETE FROM webhooks WHERE id = ?').bind(row.id),
  ]);
  return json({ deleted: true });
}

// POST /api/v1/agents/me/webhook/ping — send a test event now (agent auth)
export async function pingWebhook(
  req: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;
  const row = await q1<{ id: string; status: string }>(
    env.DB,
    'SELECT id, status FROM webhooks WHERE agent_id = ?',
    auth.id,
  );
  if (!row) {
    return err('webhook_not_found', 'No webhook registered for this agent', 404);
  }
  if (row.status !== 'active') {
    return err(
      'webhook_disabled',
      'Webhook is disabled after repeated delivery failures; set it again to re-enable',
      409,
    );
  }
  const event: WebhookEvent = {
    id: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'webhook.ping',
    created_at: Date.now(),
    data: {
      agent_id: auth.id,
      message: 'Test ping from The Pit. If you can read this, your endpoint verifies signatures correctly.',
    },
  };
  const payload = JSON.stringify(event);
  const deliveryId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO webhook_deliveries
       (id, webhook_id, event_id, event_type, payload, status, attempts, next_retry_at, created_at)
     VALUES (?, ?, ?, 'webhook.ping', ?, 'pending', 0, ?, ?)`,
  )
    .bind(deliveryId, row.id, event.id, payload, now, now)
    .run();

  // Synchronous: the whole point of a ping is immediate feedback.
  const outcome = await attemptDelivery(env, deliveryId);
  return json({
    ok: outcome.delivered,
    event_id: event.id,
    http_status: outcome.httpStatus ?? null,
    error: outcome.error ?? null,
  });
}
