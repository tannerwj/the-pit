// The Pit — fill webhooks v1 tests (mock D1, stubbed fetch, no network).
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  WEBHOOK_EVENTS,
  backoffMs,
  checkWebhookUrl,
  signWebhook,
  verifyWebhookSignature,
  newWebhookSecret,
  normalizeEventData,
  enqueueWebhookEvent,
  attemptDelivery,
} from '../src/lib/webhooks';
import { setWebhook, getWebhook, pingWebhook } from '../src/routes/webhooks';
import type { Env } from '../src/lib/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- mock D1 ---------------------------------------------------------------

type Handler = {
  match: (sql: string) => boolean;
  all?: unknown[] | ((params: unknown[]) => unknown[]);
  first?: unknown | ((params: unknown[]) => unknown);
  onRun?: (sql: string, params: unknown[]) => void;
};

function mockDb(handlers: Handler[]): { env: Env; runs: Array<{ sql: string; params: unknown[] }> } {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const find = (sql: string) =>
    handlers.find((x) => x.match(sql)) ?? { match: () => true, all: [], first: null };
  const stmt = (sql: string) => {
    const h = find(sql);
    const bound = (...p: unknown[]) => ({
      all: async () => ({
        results: typeof h.all === 'function' ? (h.all as (x: unknown[]) => unknown[])(p) : (h.all ?? []),
      }),
      first: async () =>
        typeof h.first === 'function' ? (h.first as (x: unknown[]) => unknown)(p) : (h.first ?? null),
      run: async () => {
        runs.push({ sql, params: p });
        h.onRun?.(sql, p);
        return { success: true };
      },
    });
    const unbound = bound();
    return { bind: bound, all: unbound.all, first: unbound.first, run: unbound.run };
  };
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: unknown[]) => {
      runs.push({ sql: '__batch__', params: stmts });
      return [] as unknown[];
    },
  };
  return { env: { DB: db, ADMIN_SECRET: 'x' } as unknown as Env, runs };
}

function authedJson(path: string, method: string, body?: unknown): Request {
  return new Request(`https://the-pit.twj.workers.dev${path}`, {
    method,
    headers: { 'X-API-Key': 'pit_testkey', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- URL safety ------------------------------------------------------------

describe('checkWebhookUrl', () => {
  it('accepts a normal https URL', () => {
    expect(checkWebhookUrl('https://hooks.example.com/pit-events').ok).toBe(true);
    expect(checkWebhookUrl('https://example.com/').ok).toBe(true);
  });

  it('rejects non-https schemes', () => {
    for (const u of [
      'http://example.com/hook',
      'ftp://example.com/hook',
      'file:///etc/passwd',
      'gopher://example.com/',
    ]) {
      const r = checkWebhookUrl(u);
      expect(r.ok).toBe(false);
    }
  });

  it('rejects custom ports and userinfo', () => {
    expect(checkWebhookUrl('https://example.com:8443/hook').ok).toBe(false);
    expect(checkWebhookUrl('https://user:pass@example.com/hook').ok).toBe(false);
  });

  it('rejects private / loopback / link-local IPv4 literals', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.9.9',
      '172.31.255.1',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '0.0.0.0',
      '100.64.0.1',
    ]) {
      const r = checkWebhookUrl(`https://${ip}/hook`);
      expect(r.ok).toBe(false);
    }
    // ...but a public IP literal is fine
    expect(checkWebhookUrl('https://93.184.216.34/hook').ok).toBe(true);
  });

  it('rejects private IPv6 literals', () => {
    expect(checkWebhookUrl('https://[::1]/hook').ok).toBe(false);
    expect(checkWebhookUrl('https://[fc00::1]/hook').ok).toBe(false);
    expect(checkWebhookUrl('https://[fe80::1]/hook').ok).toBe(false);
  });

  it('rejects localhost, metadata, and internal hostnames', () => {
    for (const h of [
      'localhost',
      'foo.localhost',
      'svc.local',
      'api.internal',
      'metadata.google.internal',
      'metadata',
      'db.svc.cluster.local',
      'singlelabel',
    ]) {
      const r = checkWebhookUrl(`https://${h}/hook`);
      expect(r.ok).toBe(false);
    }
  });

  it('rejects garbage', () => {
    expect(checkWebhookUrl('not a url').ok).toBe(false);
    expect(checkWebhookUrl('').ok).toBe(false);
  });
});

// --- HMAC sign / verify -----------------------------------------------------

describe('signWebhook / verifyWebhookSignature', () => {
  const secret = newWebhookSecret();
  const eventId = 'evt_abc123';
  const ts = 1758412100000;
  const body = '{"id":"evt_abc123","type":"order.filled"}';

  it('round-trips', async () => {
    const sig = await signWebhook(secret, eventId, ts, body);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyWebhookSignature(secret, eventId, ts, body, `v1,${sig}`)).toBe(true);
    // bare hex (no v1 prefix) also accepted
    expect(await verifyWebhookSignature(secret, eventId, ts, body, sig)).toBe(true);
  });

  it('rejects tampered body, wrong secret, wrong timestamp', async () => {
    const sig = await signWebhook(secret, eventId, ts, body);
    const header = `v1,${sig}`;
    expect(await verifyWebhookSignature(secret, eventId, ts, body + 'x', header)).toBe(false);
    expect(await verifyWebhookSignature(newWebhookSecret(), eventId, ts, body, header)).toBe(false);
    expect(await verifyWebhookSignature(secret, eventId, ts + 1, body, header)).toBe(false);
    expect(await verifyWebhookSignature(secret, 'evt_other', ts, body, header)).toBe(false);
  });

  it('rejects malformed signature headers', async () => {
    expect(await verifyWebhookSignature(secret, eventId, ts, body, 'v1,zzz')).toBe(false);
    expect(await verifyWebhookSignature(secret, eventId, ts, body, '')).toBe(false);
    expect(await verifyWebhookSignature(secret, eventId, ts, body, 'v1,' + '0'.repeat(63))).toBe(false);
  });
});

// --- backoff -----------------------------------------------------------------

describe('backoffMs', () => {
  it('is exponential and capped', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(100)).toBe(7_200_000);
  });
});

// --- envelope ----------------------------------------------------------------

describe('normalizeEventData', () => {
  it('fills the core keys with null where N/A and keeps extras', () => {
    const d = normalizeEventData({
      season_id: 's1',
      entry_id: 'e1',
      order_id: 'o1',
      pair: 'BTC/USD',
      side: 'buy',
      qty: 1,
      trigger: 'snapshot',
      pairs_closed: ['BTC/USD'],
    });
    expect(d.season_id).toBe('s1');
    expect(d.pair).toBe('BTC/USD');
    expect(d.fill_price).toBe(null);
    expect(d.realized_pnl).toBe(null);
    expect(d.trigger).toBe('snapshot');
    expect(d.pairs_closed).toEqual(['BTC/USD']);
    expect(Object.keys(d)).toContain('equity_after');
  });
});

// --- enqueue -----------------------------------------------------------------

const ACTIVE_WH = {
  id: 'wh_1',
  agent_id: 'ag_1',
  url: 'https://hooks.example.com/pit',
  secret: 'ab'.repeat(32),
  events: JSON.stringify(WEBHOOK_EVENTS),
  status: 'active',
  consecutive_failures: 0,
};

describe('enqueueWebhookEvent', () => {
  it('returns null when the agent has no webhook', async () => {
    const { env } = mockDb([]);
    expect(await enqueueWebhookEvent(env, undefined, 'ag_1', 'order.filled', {})).toBe(null);
  });

  it('returns null for disabled webhooks and unsubscribed events', async () => {
    const disabled = mockDb([
      { match: (s) => s.includes('FROM webhooks WHERE agent_id'), first: { ...ACTIVE_WH, status: 'disabled' } },
    ]);
    expect(await enqueueWebhookEvent(disabled.env, undefined, 'ag_1', 'order.filled', {})).toBe(null);

    const filtered = mockDb([
      { match: (s) => s.includes('FROM webhooks WHERE agent_id'), first: { ...ACTIVE_WH, events: JSON.stringify(['order.filled']) } },
    ]);
    expect(await enqueueWebhookEvent(filtered.env, undefined, 'ag_1', 'position.liquidated', {})).toBe(null);
  });

  it('inserts a pending delivery row and uses waitUntil when ctx is present', async () => {
    const { env, runs } = mockDb([
      { match: (s) => s.includes('FROM webhooks WHERE agent_id'), first: ACTIVE_WH },
    ]);
    let waited = false;
    const ctx = { waitUntil: (p: Promise<unknown>) => { waited = true; p.catch(() => {}); } } as unknown as ExecutionContext;
    // Prevent the fast-path fetch: stub fetch to fail fast.
    vi.stubGlobal('fetch', async () => { throw new Error('no network in test'); });
    const res = await enqueueWebhookEvent(env, ctx, 'ag_1', 'order.filled', { pair: 'BTC/USD' });
    expect(res).not.toBe(null);
    expect(res!.eventId.startsWith('evt_')).toBe(true);
    expect(waited).toBe(true);
    const insert = runs.find((r) => r.sql.includes('INSERT INTO webhook_deliveries'));
    expect(insert).toBeDefined();
    // columns: (id, webhook_id, event_id, event_type, payload, status='pending', ...)
    expect(insert!.params[2]).toMatch(/^evt_/); // event_id
    expect(insert!.params[3]).toBe('order.filled'); // event_type
    expect(insert!.sql).toContain("'pending'"); // status literal
    const payload = JSON.parse(insert!.params[4] as string);
    expect(payload.data.pair).toBe('BTC/USD');
    expect(payload.data.fill_price).toBe(null); // normalized envelope
    expect(payload.data.equity_after).toBe(null);
  });
});

// --- attemptDelivery -----------------------------------------------------------

function deliveryEnv(opts: { httpStatus: number; webhookStatus?: string }) {
  const delivery = {
    id: 'del_1',
    webhook_id: 'wh_1',
    event_id: 'evt_test1',
    event_type: 'order.filled',
    payload: JSON.stringify({ id: 'evt_test1', type: 'order.filled', created_at: 1, data: {} }),
    status: 'pending',
    attempts: 0,
    w_url: 'https://hooks.example.com/pit',
    w_secret: 'ab'.repeat(32),
    w_status: opts.webhookStatus ?? 'active',
  };
  vi.stubGlobal('fetch', async () => ({ status: opts.httpStatus, text: async () => 'ok' }));
  return mockDb([
    { match: (s) => s.includes('FROM webhook_deliveries d'), first: delivery },
    { match: (s) => s.includes('SELECT consecutive_failures'), first: { consecutive_failures: 0 } },
  ]);
}

describe('attemptDelivery', () => {
  it('marks delivered on 2xx and signs the request', async () => {
    const { env, runs } = deliveryEnv({ httpStatus: 200 });
    let seenHeaders: Record<string, string> = {};
    vi.stubGlobal('fetch', async (_url: unknown, init: unknown) => {
      seenHeaders = (init as { headers: Record<string, string> }).headers;
      return { status: 200, text: async () => 'ok' };
    });
    const out = await attemptDelivery(env, 'del_1');
    expect(out.delivered).toBe(true);
    expect(out.httpStatus).toBe(200);
    expect(seenHeaders['x-pit-event-id']).toBe('evt_test1');
    expect(seenHeaders['x-pit-event-type']).toBe('order.filled');
    expect(seenHeaders['x-pit-signature']).toMatch(/^v1,[0-9a-f]{64}$/);
    // signature actually verifies against the webhook secret
    const ok = await verifyWebhookSignature(
      'ab'.repeat(32),
      seenHeaders['x-pit-event-id'],
      Number(seenHeaders['x-pit-timestamp']),
      JSON.stringify({ id: 'evt_test1', type: 'order.filled', created_at: 1, data: {} }),
      seenHeaders['x-pit-signature'],
    );
    expect(ok).toBe(true);
    const batch = runs.find((r) => r.sql === '__batch__');
    expect(batch).toBeDefined(); // delivered + failure-reset updates
  });

  it('requeues as pending with backoff on 5xx', async () => {
    const { env, runs } = deliveryEnv({ httpStatus: 500 });
    const out = await attemptDelivery(env, 'del_1');
    expect(out.delivered).toBe(false);
    expect(out.httpStatus).toBe(500);
    const batch = runs.find((r) => r.sql === '__batch__');
    expect(batch).toBeDefined();
    // mockDb pushes the statements array as params: delivery update + webhook failure-count update.
    expect((batch!.params as unknown[]).length).toBe(2);
  });

  it('refuses to deliver to a disabled webhook', async () => {
    const { env } = deliveryEnv({ httpStatus: 200, webhookStatus: 'disabled' });
    const out = await attemptDelivery(env, 'del_1');
    expect(out.delivered).toBe(false);
  });
});

// --- REST routes ---------------------------------------------------------------

describe('webhook REST routes', () => {
  it('401 without an API key', async () => {
    const { env } = mockDb([]);
    const anon = new Request('https://the-pit.twj.workers.dev/api/v1/agents/me/webhook', { method: 'PUT' });
    for (const fn of [setWebhook, getWebhook]) {
      const res = await fn(anon, env);
      expect(res.status).toBe(401);
    }
    const del = await (await import('../src/routes/webhooks')).deleteWebhook(anon, env);
    expect(del.status).toBe(401);
    const pingAnon = new Request('https://the-pit.twj.workers.dev/api/v1/agents/me/webhook/ping', { method: 'POST' });
    expect((await pingWebhook(pingAnon, env)).status).toBe(401);
  });

  it('PUT rejects blocked URLs with 422', async () => {
    const { env } = mockDb([
      {
        match: (s) => s.includes('FROM agents WHERE api_key_hash'),
        first: { id: 'ag_1', email: 'a@b.c', name: 'bot', status: 'active' },
      },
    ]);
    const res = await setWebhook(
      authedJson('/api/v1/agents/me/webhook', 'PUT', { url: 'http://169.254.169.254/hook' }),
      env,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('url_blocked');
  });

  it('PUT rejects bad event lists with 422', async () => {
    const { env } = mockDb([
      {
        match: (s) => s.includes('FROM agents WHERE api_key_hash'),
        first: { id: 'ag_1', email: 'a@b.c', name: 'bot', status: 'active' },
      },
    ]);
    const res = await setWebhook(
      authedJson('/api/v1/agents/me/webhook', 'PUT', {
        url: 'https://hooks.example.com/pit',
        events: ['order.filled', 'nope'],
      }),
      env,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_events');
  });

  it('PUT upserts and returns a one-time whsec_ secret', async () => {
    const { env, runs } = mockDb([
      {
        match: (s) => s.includes('FROM agents WHERE api_key_hash'),
        first: { id: 'ag_1', email: 'a@b.c', name: 'bot', status: 'active' },
      },
      {
        match: (s) => s.includes('FROM webhooks WHERE agent_id'),
        first: { ...ACTIVE_WH, agent_id: 'ag_1', url: 'https://hooks.example.com/pit' },
      },
    ]);
    const res = await setWebhook(
      authedJson('/api/v1/agents/me/webhook', 'PUT', { url: 'https://hooks.example.com/pit' }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secret: string; webhook: { events: string[]; status: string } };
    expect(body.secret.startsWith('whsec_')).toBe(true);
    expect(body.secret.length).toBe(6 + 64);
    expect(body.webhook.events).toEqual([...WEBHOOK_EVENTS]);
    expect(runs.some((r) => r.sql.includes('INSERT INTO webhooks'))).toBe(true);
  });

  it('ping returns 404 when no webhook is registered', async () => {
    const { env } = mockDb([
      {
        match: (s) => s.includes('FROM agents WHERE api_key_hash'),
        first: { id: 'ag_1', email: 'a@b.c', name: 'bot', status: 'active' },
      },
      { match: (s) => s.includes('FROM webhooks WHERE agent_id'), first: null },
    ]);
    const res = await pingWebhook(
      authedJson('/api/v1/agents/me/webhook/ping', 'POST'),
      env,
    );
    expect(res.status).toBe(404);
  });
});
