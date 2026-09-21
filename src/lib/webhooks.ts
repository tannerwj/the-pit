// The Pit — fill webhooks v1 (pure helpers + delivery pipeline).
// SSRF protection runs at set-time AND delivery-time (see checkWebhookUrl).
// Delivery is at-least-once: a waitUntil fast path plus a D1 outbox drained
// by the 1-minute cron with exponential backoff. Receivers must dedupe on
// the event id; every delivery is HMAC-SHA256 signed.

import type { Env } from './types';
import { q, q1 } from './db';

export const WEBHOOK_EVENTS = [
  'order.filled',
  'order.cancelled',
  'position.liquidated',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/** Auto-disable after this many consecutive failed delivery attempts. */
export const MAX_CONSECUTIVE_FAILURES = 10;
/** Give up on a single event after this many attempts (then it goes 'dead'). */
export const MAX_DELIVERY_ATTEMPTS = 8;
export const DELIVERY_TIMEOUT_MS = 10_000;

export interface WebhookEvent {
  id: string; // evt_... — idempotency key for receivers
  type: string;
  created_at: number; // unix ms
  data: Record<string, unknown>;
}

interface WebhookRow {
  id: string;
  agent_id: string;
  url: string;
  secret: string;
  events: string; // JSON array
  status: string;
  consecutive_failures: number;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  payload: string;
  status: string;
  attempts: number;
}

// ---------------------------------------------------------------------------
// SSRF protection (set-time AND delivery-time)
// ---------------------------------------------------------------------------

function isIpv4(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function ipv4ToInt(host: string): number | null {
  const parts = host.split('.').map(Number);
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return (
    ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
  );
}

/** True for loopback, private (RFC1918), link-local, CGNAT, multicast, etc. */
function isPrivateIpv4(host: string): boolean {
  const ip = ipv4ToInt(host);
  if (ip === null) return true; // malformed => treat as unsafe
  const inCidr = (base: string, bits: number): boolean => {
    const b = ipv4ToInt(base);
    if (b === null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (b & mask);
  };
  return (
    inCidr('127.0.0.0', 8) || // loopback
    inCidr('10.0.0.0', 8) || // RFC1918
    inCidr('172.16.0.0', 12) || // RFC1918
    inCidr('192.168.0.0', 16) || // RFC1918
    inCidr('169.254.0.0', 16) || // link-local (cloud metadata lives here)
    inCidr('0.0.0.0', 8) || // "this network"
    inCidr('100.64.0.0', 10) || // CGNAT
    inCidr('192.0.2.0', 24) || // TEST-NET (documentation)
    inCidr('198.51.100.0', 24) ||
    inCidr('203.0.113.0', 24) ||
    inCidr('224.0.0.0', 4) // multicast
  );
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::ffff:127.0.0.1') return true;
  // ::ffff:a.b.c.d mapped IPv4 — check the embedded v4.
  const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return (
    h === '::' ||
    h.startsWith('fc') ||
    h.startsWith('fd') || // unique local fc00::/7
    h.startsWith('fe80:') ||
    h.startsWith('fe90:') ||
    h.startsWith('fea0:') ||
    h.startsWith('feb0:') // link-local fe80::/10
  );
}

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.svc.cluster.local',
  '.cluster.local',
  '.svc',
  '.consul',
  '.lan',
];
const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data-compute',
]);

/**
 * Validate a webhook URL. Rules (v1, strict and documented):
 * - https only, default port 443 (no custom ports), no userinfo
 * - no literal private/loopback/link-local IPs (v4 + v6)
 * - no localhost / single-label / internal-looking hostnames / cloud metadata hosts
 * NOTE: DNS rebinding (a public name resolving to a private IP) cannot be
 * detected without DNS resolution, which the Workers runtime does not expose;
 * the hostname blocklist plus literal-IP blocking is the practical defense.
 */
export function checkWebhookUrl(
  raw: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return { ok: false, reason: 'URL must be a non-empty string (max 2048 chars)' };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'webhook URL must use https' };
  }
  if (u.username !== '' || u.password !== '') {
    return { ok: false, reason: 'userinfo in webhook URL is not allowed' };
  }
  if (u.port !== '') {
    return { ok: false, reason: 'custom ports are not allowed (https/443 only)' };
  }
  const host = u.hostname.toLowerCase();
  if (host.length === 0) return { ok: false, reason: 'URL has no host' };

  // Node/Workers keep IPv6 brackets in .hostname ("[::1]"); strip them so the
  // literal-IP checks below see the real address.
  const ip = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const looksIpv6 = ip.includes(':');
  const looksIpv4 = isIpv4(ip);
  if (looksIpv6 || looksIpv4) {
    const priv = looksIpv6 ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
    if (priv) {
      return { ok: false, reason: 'private/loopback/link-local IP addresses are not allowed' };
    }
    return { ok: true };
  }
  if (BLOCKED_HOSTS.has(host)) {
    return { ok: false, reason: `hostname "${host}" is not allowed` };
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return { ok: false, reason: `internal hostname suffix "${suffix}" is not allowed` };
    }
  }
  if (!host.includes('.')) {
    return { ok: false, reason: 'single-label hostnames are not allowed' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 signing
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** Signed message format: `${eventId}.${timestamp}.${body}` (like Svix). */
export async function signWebhook(
  secretHex: string,
  eventId: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(secretHex),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${eventId}.${timestamp}.${body}`),
  );
  return bytesToHex(new Uint8Array(sig));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** Verify an `X-Pit-Signature: v1,<hex>` header. Exported for tests + docs. */
export async function verifyWebhookSignature(
  secretHex: string,
  eventId: string,
  timestamp: number,
  body: string,
  signatureHeader: string,
): Promise<boolean> {
  const hex = signatureHeader.startsWith('v1,')
    ? signatureHeader.slice(3)
    : signatureHeader;
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const expected = await signWebhook(secretHex, eventId, timestamp, body);
  return timingSafeEqualHex(expected, hex);
}

/** Generate a fresh per-webhook signing secret (raw hex, stored; shown once). */
export function newWebhookSecret(): string {
  return randomHex(32); // 64 hex chars
}

// ---------------------------------------------------------------------------
// Delivery pipeline
// ---------------------------------------------------------------------------

export function backoffMs(attempts: number): number {
  // attempts = number of failed attempts so far (1-based): 30s, 60s, 120s, ...
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 7_200_000);
}

export interface DeliveryOutcome {
  delivered: boolean;
  httpStatus?: number;
  error?: string;
}

function webhookHeaders(
  event: WebhookEvent,
  body: string,
  signature: string,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'user-agent': 'the-pit-webhooks/1.0',
    'x-pit-event-id': event.id,
    'x-pit-event-type': event.type,
    'x-pit-timestamp': String(event.created_at),
    'x-pit-signature': `v1,${signature}`,
  };
}

async function markDelivered(
  env: Env,
  deliveryId: string,
  webhookId: string,
  httpStatus: number,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE webhook_deliveries
       SET status = 'delivered', http_status = ?, attempts = attempts + 1, delivered_at = ?
       WHERE id = ?`,
    ).bind(httpStatus, now, deliveryId),
    env.DB.prepare(
      `UPDATE webhooks
       SET consecutive_failures = 0, last_error = NULL, last_delivery_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(now, now, webhookId),
  ]);
}

async function markFailed(
  env: Env,
  deliveryId: string,
  webhookId: string,
  attempts: number,
  httpStatus: number | null,
  error: string,
): Promise<DeliveryOutcome> {
  const now = Date.now();
  const dead = attempts + 1 >= MAX_DELIVERY_ATTEMPTS;
  const nextStatus = dead ? 'dead' : 'pending';
  const nextRetry = dead ? now : now + backoffMs(attempts + 1);
  // consecutive_failures counts attempts, not just dead letters.
  const res = await env.DB.prepare(
    'SELECT consecutive_failures FROM webhooks WHERE id = ?',
  )
    .bind(webhookId)
    .first<{ consecutive_failures: number }>();
  const failures = (res?.consecutive_failures ?? 0) + 1;
  const disabled = failures >= MAX_CONSECUTIVE_FAILURES;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE webhook_deliveries
       SET status = ?, http_status = ?, attempts = attempts + 1, next_retry_at = ?
       WHERE id = ?`,
    ).bind(nextStatus, httpStatus, nextRetry, deliveryId),
    env.DB.prepare(
      `UPDATE webhooks
       SET consecutive_failures = ?, last_error = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      failures,
      error.slice(0, 500),
      disabled ? 'disabled' : 'active',
      now,
      webhookId,
    ),
  ]);
  return {
    delivered: false,
    httpStatus: httpStatus ?? undefined,
    error: disabled
      ? `webhook auto-disabled after ${failures} consecutive failures: ${error}`
      : error,
  };
}

/**
 * Attempt one delivery of a pending row. Re-checks the webhook (still active)
 * and the URL (delivery-time SSRF check). Returns the outcome; updates the
 * delivery row and the webhook's failure counters.
 */
export async function attemptDelivery(
  env: Env,
  deliveryId: string,
): Promise<DeliveryOutcome> {
  const row = await q1<DeliveryRow>(
    env.DB,
    `SELECT d.id, d.webhook_id, d.event_id, d.event_type, d.payload, d.status, d.attempts,
            w.url AS w_url, w.secret AS w_secret, w.status AS w_status
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.id = ?`,
    deliveryId,
  );
  if (!row) return { delivered: false, error: 'delivery row not found' };
  const url = (row as DeliveryRow & { w_url: string }).w_url;
  const secret = (row as DeliveryRow & { w_secret: string }).w_secret;
  const wStatus = (row as DeliveryRow & { w_status: string }).w_status;
  if (wStatus !== 'active' || row.status === 'dead' || row.status === 'delivered') {
    return { delivered: false, error: `not deliverable (webhook=${wStatus}, delivery=${row.status})` };
  }
  // Delivery-time SSRF re-check (defense against URL changes / DNS tricks).
  const safety = checkWebhookUrl(url);
  if (!safety.ok) {
    return markFailed(env, deliveryId, row.webhook_id, row.attempts, null, `SSRF re-check failed: ${safety.reason}`);
  }

  const event: WebhookEvent = JSON.parse(row.payload);
  const signature = await signWebhook(secret, event.id, event.created_at, row.payload);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: webhookHeaders(event, row.payload, signature),
      body: row.payload,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return markFailed(env, deliveryId, row.webhook_id, row.attempts, null, `fetch failed: ${msg}`);
  }
  // Drain the body so the connection can be reused; ignore errors.
  try {
    await res.text();
  } catch {
    /* ignore */
  }
  if (res.status >= 200 && res.status < 300) {
    await markDelivered(env, deliveryId, row.webhook_id, res.status);
    return { delivered: true, httpStatus: res.status };
  }
  return markFailed(
    env,
    deliveryId,
    row.webhook_id,
    row.attempts,
    res.status,
    `unexpected HTTP ${res.status}`,
  );
}

export interface EnqueueResult {
  eventId: string;
  deliveryId: string;
}

/**
 * Consistent event envelope: every event carries the same core keys so agents
 * can parse one shape. Order-level fields are null where they don't apply
 * (e.g. pair/side/qty on aggregate liquidations; fill_price/realized_pnl on
 * cancellations which never filled). Event-specific extras (type, limit_price,
 * trigger, pairs_closed, reason) are preserved as-is.
 */
const EVENT_CORE_KEYS = [
  'season_id',
  'entry_id',
  'order_id',
  'pair',
  'side',
  'qty',
  'fill_price',
  'realized_pnl',
  'equity_after',
  'entry_status',
] as const;

export function normalizeEventData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of EVENT_CORE_KEYS) out[k] = k in data ? data[k] : null;
  for (const [k, v] of Object.entries(data)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/**
 * Enqueue a webhook event for an agent. Never throws for missing/disabled
 * webhooks (returns null) — delivery must never break the fill path.
 * The pending row is the outbox; when ctx is available the first attempt
 * goes out immediately via waitUntil, otherwise the 1-minute cron picks it up.
 */
export async function enqueueWebhookEvent(
  env: Env,
  ctx: ExecutionContext | undefined,
  agentId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<EnqueueResult | null> {
  try {
    const wh = await q1<WebhookRow>(
      env.DB,
      'SELECT id, agent_id, url, secret, events, status, consecutive_failures FROM webhooks WHERE agent_id = ?',
      agentId,
    );
    if (!wh || wh.status !== 'active') return null;
    let events: string[];
    try {
      events = JSON.parse(wh.events);
    } catch {
      events = [...WEBHOOK_EVENTS];
    }
    if (!events.includes(type)) return null;
    const safety = checkWebhookUrl(wh.url);
    if (!safety.ok) return null;

    const event: WebhookEvent = {
      id: `evt_${randomHex(12)}`,
      type,
      created_at: Date.now(),
      data: normalizeEventData(data),
    };
    const payload = JSON.stringify(event);
    const deliveryId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO webhook_deliveries
         (id, webhook_id, event_id, event_type, payload, status, attempts, next_retry_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    )
      .bind(deliveryId, wh.id, event.id, type, payload, now, now)
      .run();

    if (ctx) {
      ctx.waitUntil(
        attemptDelivery(env, deliveryId).catch((e) => {
          console.error('webhook fast-path delivery failed', deliveryId, e);
        }),
      );
    }
    return { eventId: event.id, deliveryId };
  } catch (e) {
    // The fill path must never fail because webhooks did.
    console.error('enqueueWebhookEvent failed', agentId, type, e);
    return null;
  }
}

/** 1-minute cron: retry pending deliveries whose backoff has elapsed. */
export async function drainWebhookOutbox(env: Env): Promise<number> {
  const now = Date.now();
  const rows = await q<{ id: string }>(
    env.DB,
    `SELECT id FROM webhook_deliveries
     WHERE status = 'pending' AND next_retry_at <= ?
     ORDER BY next_retry_at ASC LIMIT 25`,
    now,
  );
  let attempted = 0;
  for (const r of rows) {
    try {
      await attemptDelivery(env, r.id);
      attempted += 1;
    } catch (e) {
      console.error('webhook outbox delivery failed', r.id, e);
    }
  }
  return attempted;
}
