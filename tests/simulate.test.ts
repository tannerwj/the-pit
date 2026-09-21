// The Pit — public simulator endpoint tests (mock D1, no network).
import { describe, it, expect, beforeEach } from 'vitest';
import {
  postSimulate,
  resetSimulateRateLimit,
  simulateRateOk,
  SIMULATE_MAX_TRADES,
} from '../src/routes/simulate';
import { postBacktest } from '../src/routes/backtest';
import type { Env } from '../src/lib/types';

beforeEach(() => {
  resetSimulateRateLimit();
});

type Handler = {
  match: (sql: string) => boolean;
  all?: (sql: string, params: unknown[]) => unknown[];
  first?: unknown | ((params: unknown[]) => unknown);
};

function mockDb(handlers: Handler[]): { env: Env; runs: string[] } {
  const runs: string[] = [];
  const find = (sql: string) =>
    handlers.find((x) => x.match(sql)) ?? { match: () => true };
  const stmt = (sql: string) => {
    const h = find(sql);
    const bound = (...p: unknown[]) => ({
      all: async () => ({
        results: h.all ? h.all(sql, p) : [],
      }),
      first: async () => (typeof h.first === 'function' ? h.first(p) : (h.first ?? null)),
      run: async () => {
        runs.push(sql);
        return { success: true };
      },
    });
    return { bind: bound, all: () => bound().all(), first: () => bound().first(), run: () => bound().run() };
  };
  const db = { prepare: stmt, batch: async () => [] as unknown[] };
  return { env: { DB: db, ADMIN_SECRET: 'x' } as unknown as Env, runs };
}

/** Synthetic quotes for the nearest-quote-at-or-before timeline query. */
function quotesHandler(): Handler {
  return {
    match: (s) => s.includes('WITH needs(ts)'),
    all: (sql) => {
      const hits = sql.match(/\(\d+\)/g) ?? [];
      return hits.map((x) => {
        const ts = Number(x.slice(1, -1));
        const mid = 60000 + ((ts / 3_600_000) % 24) * 10;
        return { need_ts: ts, bid: mid - 50, ask: mid + 50 };
      });
    },
  };
}

const post = (body: unknown, raw?: string, ip = '203.0.113.7') =>
  new Request('https://the-pit.twj.workers.dev/api/v1/simulate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });

const T1 = Date.UTC(2026, 2, 10, 12);
const T2 = Date.UTC(2026, 2, 11, 12);

describe('POST /api/v1/simulate', () => {
  it('needs no API key', async () => {
    const { env } = mockDb([]);
    const res = await postSimulate(post({ trades: [] }), env);
    expect(res.status).toBe(200);
  });

  it('400 on invalid JSON', async () => {
    const { env } = mockDb([]);
    const res = await postSimulate(post(null, '{nope'), env);
    expect(res.status).toBe(400);
  });

  it('422 on malformed bodies', async () => {
    const cases: Array<[string, unknown]> = [
      ['missing trades', {}],
      ['trades not an array', { trades: 'x' }],
      ['bad pair', { trades: [{ pair: 'NOPE/USD', side: 'long', qty: 1, timestamp: T1 }] }],
      ['bad side', { trades: [{ pair: 'BTC/USD', side: 'buy', qty: 1, timestamp: T1 }] }],
      ['both qty and notional', { trades: [{ pair: 'BTC/USD', side: 'long', qty: 1, notional: 5, timestamp: T1 }] }],
      ['neither qty nor notional', { trades: [{ pair: 'BTC/USD', side: 'long', timestamp: T1 }] }],
      ['negative qty', { trades: [{ pair: 'BTC/USD', side: 'long', qty: -1, timestamp: T1 }] }],
      ['future timestamp', { trades: [{ pair: 'BTC/USD', side: 'long', qty: 1, timestamp: Date.now() + 3_600_000 }] }],
      ['capital too low', { starting_capital: 50, trades: [] }],
      ['capital too high', { starting_capital: 1_000_001, trades: [] }],
    ];
    for (const [name, body] of cases) {
      const { env } = mockDb([]);
      const res = await postSimulate(post(body), env);
      expect(res.status, name).toBe(422);
    }
  });

  it(`422 past ${SIMULATE_MAX_TRADES} trades, 200 at the cap`, async () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        pair: 'BTC/USD',
        side: 'long',
        notional: 10,
        timestamp: T1 + i,
      }));
    const { env } = mockDb([quotesHandler()]);
    const over = await postSimulate(post({ trades: mk(SIMULATE_MAX_TRADES + 1) }), env);
    expect(over.status).toBe(422);
    const body = (await over.json()) as { error: { message: string } };
    expect(body.error.message).toContain(String(SIMULATE_MAX_TRADES));

    const { env: env2 } = mockDb([quotesHandler()]);
    const at = await postSimulate(post({ trades: mk(SIMULATE_MAX_TRADES) }), env2);
    expect(at.status).toBe(200);
  });

  it('empty trades -> flat curve at starting capital', async () => {
    const { env, runs } = mockDb([quotesHandler()]);
    const res = await postSimulate(post({ starting_capital: 25000, trades: [] }), env);
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      starting_capital: number;
      return_pct: number;
      points: Array<{ t: number; equity: number }>;
      summary: string;
    };
    expect(j.starting_capital).toBe(25000);
    expect(j.return_pct).toBe(0);
    expect(j.points.length).toBeGreaterThan(0);
    expect(j.points.every((p) => p.equity === 25000)).toBe(true);
    expect(typeof j.summary).toBe('string');
    expect(runs).toHaveLength(0); // nothing written to D1
  });

  it('replays trades through the live fill model and writes nothing', async () => {
    const { env, runs } = mockDb([quotesHandler()]);
    const res = await postSimulate(
      post({
        starting_capital: 10000,
        trades: [
          { pair: 'BTC/USD', side: 'long', notional: 2000, timestamp: T1 },
          { pair: 'BTC/USD', side: 'short', notional: 1000, timestamp: T2 },
        ],
      }),
      env,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      trades_filled: number;
      points: Array<{ t: number; equity: number }>;
      trades: Array<{ status: string; fill_price: number | null }>;
      summary: string;
      honesty: Record<string, string>;
    };
    expect(j.trades_filled).toBe(2);
    expect(j.points.length).toBeGreaterThan(2);
    expect(j.trades.every((t) => t.status === 'filled' && t.fill_price !== null)).toBe(true);
    expect(j.summary).toContain('hypothetical');
    expect(j.honesty.writes).toContain('none');
    expect(runs).toHaveLength(0);
  });

  it('response shape matches the authenticated backtest for the same input', async () => {
    const body = {
      starting_capital: 10000,
      trades: [{ pair: 'ETH/USD', side: 'short', qty: 2, timestamp: T1 }],
    };
    const { env: env1 } = mockDb([quotesHandler()]);
    const sim = (await (await postSimulate(post(body), env1)).json()) as Record<string, unknown>;

    const { env: env2 } = mockDb([
      quotesHandler(),
      {
        match: (s) => s.includes('FROM agents WHERE api_key_hash'),
        first: { id: 'ag_1', email: 'a@b.c', name: 'bot', status: 'active' },
      },
    ]);
    const bt = (await (
      await postBacktest(
        new Request('https://the-pit.twj.workers.dev/api/v1/backtest', {
          method: 'POST',
          headers: { 'X-API-Key': 'pit_testkey', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        env2,
      )
    ).json()) as Record<string, unknown>;

    expect(Object.keys(sim).sort()).toEqual(Object.keys(bt).sort());
    expect(sim).toEqual(bt);
  });
});

describe('simulate per-IP rate limit', () => {
  it('allows 20 requests per minute, then 429s with Retry-After', async () => {
    const { env } = mockDb([]);
    for (let i = 0; i < 20; i++) {
      const res = await postSimulate(post({ trades: [] }, undefined, '198.51.100.9'), env);
      expect(res.status).toBe(200);
    }
    const limited = await postSimulate(post({ trades: [] }, undefined, '198.51.100.9'), env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    const j = (await limited.json()) as { error: { code: string } };
    expect(j.error.code).toBe('rate_limited');
  });

  it('is per-IP: another IP is unaffected', async () => {
    const { env } = mockDb([]);
    for (let i = 0; i < 20; i++) {
      await postSimulate(post({ trades: [] }, undefined, '198.51.100.9'), env);
    }
    const res = await postSimulate(post({ trades: [] }, undefined, '203.0.113.8'), env);
    expect(res.status).toBe(200);
  });

  it('window slides: old hits expire', () => {
    const ip = '198.51.100.10';
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) {
      expect(simulateRateOk(ip, t0 + i * 1000)).toBe(true);
    }
    expect(simulateRateOk(ip, t0 + 20_000)).toBe(false);
    // 61s after the first hit, the window has slid past it.
    expect(simulateRateOk(ip, t0 + 61_000)).toBe(true);
  });
});

/** Hourly-grid quotes: each candle's mid is unique per hour, so a market point
 *  at time T must price exactly the candle at-or-before T (no lookahead). */
function hourlyGridHandler(): Handler {
  return {
    match: (s) => s.includes('WITH needs(ts)'),
    all: (sql) => {
      const hits = sql.match(/\(\d+\)/g) ?? [];
      return hits.map((x) => {
        const ts = Number(x.slice(1, -1));
        const candle = Math.floor(ts / 3_600_000) * 3_600_000;
        const mid = 1000 + candle / 3_600_000;
        return { need_ts: ts, bid: mid - 1, ask: mid + 1 };
      });
    },
  };
}

/** Flat quotes: mid exactly 50000 everywhere. */
function flatQuotesHandler(): Handler {
  return {
    match: (s) => s.includes('WITH needs(ts)'),
    all: (sql) => {
      const hits = sql.match(/\(\d+\)/g) ?? [];
      return hits.map((x) => {
        const ts = Number(x.slice(1, -1));
        return { need_ts: ts, bid: 49950, ask: 50050 };
      });
    },
  };
}

describe('POST /api/v1/simulate market replay chart', () => {
  const T3 = T1 + 2 * 86400_000;

  it('market series is bounded, ordered, in-window, and no-lookahead', async () => {
    const { env } = mockDb([hourlyGridHandler()]);
    const res = await postSimulate(
      post({
        starting_capital: 10000,
        trades: [
          { pair: 'BTC/USD', side: 'long', notional: 1000, timestamp: T1 },
          { pair: 'BTC/USD', side: 'short', notional: 500, timestamp: T3 },
        ],
      }),
      env,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      timeframe: { from: number; to: number };
      market: Record<string, Array<{ t: number; price: number }>>;
    };
    // Default timeframe = trade-implied span.
    expect(j.timeframe.from).toBe(T1 - 1);
    expect(j.timeframe.to).toBe(T3);
    const m = j.market['BTC/USD'];
    expect(m.length).toBeGreaterThan(1);
    expect(m.length).toBeLessThanOrEqual(600);
    for (let i = 1; i < m.length; i++) expect(m[i].t).toBeGreaterThan(m[i - 1].t);
    for (const p of m) {
      expect(p.t).toBeGreaterThanOrEqual(j.timeframe.from);
      expect(p.t).toBeLessThanOrEqual(j.timeframe.to);
      // No lookahead: price is exactly the mid of the candle at-or-before t.
      expect(p.price).toBe(1000 + Math.floor(p.t / 3_600_000));
    }
  });

  it('multi-pair responses carry one bounded series per pair', async () => {
    const { env } = mockDb([hourlyGridHandler()]);
    const res = await postSimulate(
      post({
        starting_capital: 10000,
        trades: [
          { pair: 'BTC/USD', side: 'long', notional: 1000, timestamp: T1 },
          { pair: 'ETH/USD', side: 'short', notional: 500, timestamp: T1 + 3600_000 },
        ],
      }),
      env,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      market: Record<string, Array<{ t: number; price: number }>>;
    };
    expect(Object.keys(j.market).sort()).toEqual(['BTC/USD', 'ETH/USD']);
    for (const s of Object.values(j.market)) expect(s.length).toBeLessThanOrEqual(600);
  });

  it('explicit from/to set the chart timeframe; bad values are 422', async () => {
    const { env } = mockDb([hourlyGridHandler()]);
    const from = T1 - 86400_000;
    const to = T1 + 86400_000;
    const res = await postSimulate(
      post({
        starting_capital: 10000,
        from,
        to,
        trades: [{ pair: 'BTC/USD', side: 'long', notional: 1000, timestamp: T1 }],
      }),
      env,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      timeframe: { from: number; to: number };
      points: Array<{ t: number; equity: number }>;
      market: Record<string, Array<{ t: number; price: number }>>;
    };
    expect(j.timeframe).toEqual({ from, to });
    // Equity curve is anchored at the explicit from (starting capital).
    expect(j.points[0].t).toBe(from);
    expect(j.points[0].equity).toBe(10000);
    for (const p of j.market['BTC/USD']) {
      expect(p.t).toBeGreaterThanOrEqual(from);
      expect(p.t).toBeLessThanOrEqual(to);
    }

    const badOrder = await postSimulate(
      post({ from: to, to: from, trades: [] }),
      mockDb([]).env,
    );
    expect(badOrder.status).toBe(422);
    const badType = await postSimulate(
      post({ from: 'yesterday', trades: [] }),
      mockDb([]).env,
    );
    expect(badType.status).toBe(422);
  });

  it('per-trade fill prices and realized PnL follow the live fill model', async () => {
    const { env } = mockDb([flatQuotesHandler()]);
    const res = await postSimulate(
      post({
        starting_capital: 10000,
        trades: [
          { pair: 'BTC/USD', side: 'long', notional: 1000, timestamp: T1 },
          { pair: 'BTC/USD', side: 'short', notional: 500, timestamp: T1 + 3600_000 },
        ],
      }),
      env,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      trades: Array<{
        ts: number;
        side: string;
        status: string;
        fill_price: number | null;
        realized_pnl: number;
        equity_after: number;
      }>;
    };
    // Marker timestamps match the submitted fill times exactly.
    expect(j.trades.map((t) => t.ts)).toEqual([T1, T1 + 3600_000]);
    // Touch-side + 5bps slippage: buy at ask*1.0005, sell at bid*0.9995.
    expect(j.trades[0].fill_price).toBeCloseTo(50050 * 1.0005, 6);
    expect(j.trades[1].fill_price).toBeCloseTo(49950 * 0.9995, 6);
    // Opening trade realizes nothing; the round-trip loses to spread+slippage.
    expect(j.trades[0].realized_pnl).toBe(0);
    const closeQty = 500 / (49950 * 0.9995);
    const expected = closeQty * (49950 * 0.9995 - 50050 * 1.0005);
    expect(j.trades[1].realized_pnl).toBeCloseTo(expected, 6);
    expect(j.trades[1].realized_pnl).toBeLessThan(0);
  });
});
