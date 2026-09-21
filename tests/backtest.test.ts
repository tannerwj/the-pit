// The Pit — backtest engine + route tests (mock D1, no network).
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  runBacktestReplay,
  backtestStats,
  backtestSummary,
  type BacktestTradeInput,
} from '../src/lib/backtest';
import { postBacktest } from '../src/routes/backtest';
import type { WhatIfQuote } from '../src/lib/whatif';
import type { Env } from '../src/lib/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

const T0 = 1_000_000;
const T1 = 2_000_000;
const T2 = 3_000_000;
const T3 = 4_000_000;

function q(ts: number, mid: number): WhatIfQuote {
  return { ts, bid: mid - 50, ask: mid + 50 };
}

const BTC = (mids: Array<[number, number]>): WhatIfQuote[] =>
  mids.map(([ts, mid]) => q(ts, mid));

function quotes(pairs: Array<[string, WhatIfQuote[]]>): Map<string, WhatIfQuote[]> {
  const m = new Map<string, WhatIfQuote[]>();
  for (const [p, qs] of pairs) m.set(p, [...qs].sort((a, b) => a.ts - b.ts));
  return m;
}

function trade(
  ts: number,
  side: 'long' | 'short',
  qty: number | null = 1,
  notional: number | null = null,
  pair = 'BTC/USD',
): BacktestTradeInput {
  return { pair, side, qty, notional, ts };
}

// ---------------------------------------------------------------------------
// Pure engine
// ---------------------------------------------------------------------------

describe('runBacktestReplay', () => {
  it('empty trades -> flat curve at starting capital', () => {
    const r = runBacktestReplay({
      trades: [],
      quotesByPair: quotes([['BTC/USD', BTC([[T0, 60000]])]]),
      timeline: [T0],
      startingCapital: 10_000,
    });
    expect(r.filled).toBe(0);
    expect(r.rejected).toBe(0);
    expect(r.points).toHaveLength(1);
    expect(r.points[0].equity).toBe(10_000);
    expect(r.finalEquity).toBe(10_000);
    expect(r.realizedPnl).toBe(0);
    const s = backtestStats(r.points, 10_000);
    expect(s.return_pct).toBe(0);
  });

  it('long profits when the price rises (live fill model: ask + 5bps)', () => {
    const qs = BTC([[T1, 60000], [T2, 61000]]);
    const r = runBacktestReplay({
      trades: [trade(T1, 'long', 1)],
      quotesByPair: quotes([['BTC/USD', qs]]),
      timeline: [T1 - 1, T1, T2],
      startingCapital: 1_000_000,
    });
    expect(r.filled).toBe(1);
    const fillPrice = 60050 * 1.0005; // ask + 5bps
    expect(r.trades[0].fill_price).toBeCloseTo(fillPrice, 6);
    expect(r.trades[0].status).toBe('filled');
    // Curve starts flat at starting capital (pre-trade anchor).
    expect(r.points[0].equity).toBe(1_000_000);
    // Still open at T2: marked at mid 61000.
    expect(r.finalEquity).toBeCloseTo(1_000_000 - fillPrice + 61000, 6);
    expect(r.finalEquity).toBeGreaterThan(1_000_000);
    expect(r.realizedPnl).toBe(0);
  });

  it('round trip realizes PnL; 2x qty doubles it exactly', () => {
    const qs = BTC([[T1, 60000], [T2, 62000]]);
    const base = {
      quotesByPair: quotes([['BTC/USD', qs]]),
      timeline: [T1 - 1, T1, T2],
      startingCapital: 1_000_000,
    };
    const one = runBacktestReplay({
      ...base,
      trades: [trade(T1, 'long', 1), trade(T2, 'short', 1)],
    });
    const two = runBacktestReplay({
      ...base,
      trades: [trade(T1, 'long', 2), trade(T2, 'short', 2)],
    });
    expect(one.filled).toBe(2);
    expect(one.realizedPnl).toBeGreaterThan(0);
    expect(two.realizedPnl).toBeCloseTo(one.realizedPnl * 2, 8);
    expect(two.finalEquity - 1_000_000).toBeCloseTo((one.finalEquity - 1_000_000) * 2, 6);
  });

  it('no lookahead: shifting a trade earlier never changes fills that precede it', () => {
    const qs = BTC([[T1, 60000], [T2, 61000], [T3, 62000]]);
    const base = {
      quotesByPair: quotes([['BTC/USD', qs]]),
      timeline: [T0, T1, T2, T3],
      startingCapital: 1_000_000,
    };
    const before = runBacktestReplay({
      ...base,
      trades: [trade(T1, 'long', 1), trade(T2, 'long', 1), trade(T3, 'short', 2)],
    });
    // Move the middle trade earlier (still after the first).
    const after = runBacktestReplay({
      ...base,
      trades: [trade(T1, 'long', 1), trade(T1 + 500_000, 'long', 1), trade(T3, 'short', 2)],
    });
    const fillA1 = before.trades.find((t) => t.index === 0)!.fill_price;
    const fillA2 = after.trades.find((t) => t.index === 0)!.fill_price;
    expect(fillA1).toBe(fillA2); // first fill untouched by the later shift
    // The shifted trade itself fills at the earlier (cheaper) quote.
    const fillB1 = before.trades.find((t) => t.index === 1)!.fill_price!;
    const fillB2 = after.trades.find((t) => t.index === 1)!.fill_price!;
    expect(fillB2).toBeLessThan(fillB1);
  });

  it('rejects trades that would breach the 3x leverage cap', () => {
    const r = runBacktestReplay({
      trades: [trade(T1, 'long', 100)], // 100 BTC @ ~60k on $10k = 600x
      quotesByPair: quotes([['BTC/USD', BTC([[T1, 60000]])]]),
      timeline: [T1 - 1, T1],
      startingCapital: 10_000,
    });
    expect(r.filled).toBe(0);
    expect(r.rejected).toBe(1);
    expect(r.trades[0].status).toBe('rejected');
    expect(r.trades[0].reject_reason).toBe('leverage');
    expect(r.finalEquity).toBe(10_000); // nothing applied
  });

  it('allows trades right at the leverage edge but not over', () => {
    // 0.4 BTC @ ~60k ask+slippage ~= $24k notional on $10k -> 2.4x: OK.
    const ok = runBacktestReplay({
      trades: [trade(T1, 'long', 0.4)],
      quotesByPair: quotes([['BTC/USD', BTC([[T1, 60000]])]]),
      timeline: [T1 - 1, T1],
      startingCapital: 10_000,
    });
    expect(ok.trades[0].status).toBe('filled');
    // 0.6 BTC ~= $36k notional -> 3.6x: rejected.
    const no = runBacktestReplay({
      trades: [trade(T1, 'long', 0.6)],
      quotesByPair: quotes([['BTC/USD', BTC([[T1, 60000]])]]),
      timeline: [T1 - 1, T1],
      startingCapital: 10_000,
    });
    expect(no.trades[0].status).toBe('rejected');
    expect(no.trades[0].reject_reason).toBe('leverage');
  });

  it('rejects trades older than the earliest history', () => {
    const r = runBacktestReplay({
      trades: [trade(T0, 'long', 1)],
      quotesByPair: quotes([['BTC/USD', BTC([[T1, 60000]])]]),
      timeline: [T0, T1],
      startingCapital: 10_000,
    });
    expect(r.trades[0].status).toBe('rejected');
    expect(r.trades[0].reject_reason).toBe('no_history');
  });

  it('resolves notional to qty at the fill price', () => {
    const r = runBacktestReplay({
      trades: [trade(T1, 'long', null, 60_000)],
      quotesByPair: quotes([['BTC/USD', BTC([[T1, 60000]])]]),
      timeline: [T1 - 1, T1],
      startingCapital: 1_000_000,
    });
    const tr = r.trades[0];
    expect(tr.status).toBe('filled');
    expect(tr.qty).toBeCloseTo(60_000 / tr.fill_price!, 10);
    expect(tr.notional_usd).toBeCloseTo(60_000, 6);
  });

  it('short profits when the price falls', () => {
    const r = runBacktestReplay({
      trades: [trade(T1, 'short', 1), trade(T2, 'long', 1)],
      quotesByPair: quotes([['BTC/USD', BTC([[T1, 60000], [T2, 59000]])]]),
      timeline: [T1 - 1, T1, T2],
      startingCapital: 1_000_000,
    });
    expect(r.filled).toBe(2);
    expect(r.realizedPnl).toBeGreaterThan(0);
    expect(r.finalEquity).toBeGreaterThan(1_000_000);
  });

  it('summary is one plain-English line with the key numbers', () => {
    const s = backtestSummary({
      startingCapital: 10_000,
      finalEquity: 12_340,
      returnPct: 23.4,
      maxDd: 8.1,
      sharpe: 1.2,
      filled: 4,
      rejected: 1,
      pairs: ['BTC/USD'],
      fromTs: Date.UTC(2026, 2, 1),
      toTs: Date.UTC(2026, 8, 1),
    });
    expect(s).toContain('4 hypothetical trades');
    expect(s).toContain('BTC/USD');
    expect(s).toContain('$10,000');
    expect(s).toContain('$12,340');
    expect(s).toContain('+23.4%');
    expect(s).toContain('max drawdown 8.1%');
    expect(s).not.toContain('max drawdown +8.1%');
    expect(s).toContain('1 trade was skipped');
    expect(s).not.toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// Route (mock D1)
// ---------------------------------------------------------------------------

type Handler = {
  match: (sql: string) => boolean;
  all?: unknown[] | ((params: unknown[]) => unknown[]);
  first?: unknown | ((params: unknown[]) => unknown);
  onRun?: (sql: string, params: unknown[]) => void;
};

function mockDb(handlers: Handler[]): { env: Env; runs: string[] } {
  const runs: string[] = [];
  const find = (sql: string) =>
    handlers.find((x) => x.match(sql)) ?? { match: () => true, all: [], first: null };
  const stmt = (sql: string) => {
    const h = find(sql);
    const bound = (...p: unknown[]) => ({
      all: async () => ({
        results:
          typeof h.all === 'function' ? (h.all as (x: unknown[]) => unknown[])(p) : (h.all ?? []),
      }),
      first: async () =>
        typeof h.first === 'function' ? (h.first as (x: unknown[]) => unknown)(p) : (h.first ?? null),
      run: async () => {
        runs.push(sql);
        h.onRun?.(sql, p);
        return { success: true };
      },
    });
    return { bind: bound, all: () => bound().all(), first: () => bound().first(), run: () => bound().run() };
  };
  const db = { prepare: stmt, batch: async () => [] as unknown[] };
  return { env: { DB: db, ADMIN_SECRET: 'x' } as unknown as Env, runs };
}

const authed = (body: unknown, raw?: string) =>
  new Request('https://the-pit.twj.workers.dev/api/v1/backtest', {
    method: 'POST',
    headers: { 'X-API-Key': 'pit_testkey', 'content-type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });

function authOnly(): Handler {
  return {
    match: (s) => s.includes('FROM agents WHERE api_key_hash'),
    first: { id: 'ag_1', email: 'a@b.c', name: 'bot', status: 'active' },
  };
}

describe('POST /api/v1/backtest', () => {
  it('401 without an API key', async () => {
    const { env } = mockDb([]);
    const res = await postBacktest(
      new Request('https://the-pit.twj.workers.dev/api/v1/backtest', {
        method: 'POST',
        body: JSON.stringify({ trades: [] }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('400 on invalid JSON', async () => {
    const { env } = mockDb([authOnly()]);
    const res = await postBacktest(authed(null, '{nope'), env);
    expect(res.status).toBe(400);
  });

  it('422 on malformed bodies', async () => {
    const cases: Array<[string, unknown]> = [
      ['missing trades', {}],
      ['trades not an array', { trades: 'x' }],
      ['bad pair', { trades: [{ pair: 'NOPE/USD', side: 'long', qty: 1, timestamp: T1 }] }],
      ['bad side', { trades: [{ pair: 'BTC/USD', side: 'buy', qty: 1, timestamp: T1 }] }],
      ['future timestamp', { trades: [{ pair: 'BTC/USD', side: 'long', qty: 1, timestamp: Date.now() + 60_000 }] }],
      ['non-integer timestamp', { trades: [{ pair: 'BTC/USD', side: 'long', qty: 1, timestamp: 1.5 }] }],
      ['qty and notional', { trades: [{ pair: 'BTC/USD', side: 'long', qty: 1, notional: 5, timestamp: T1 }] }],
      ['neither qty nor notional', { trades: [{ pair: 'BTC/USD', side: 'long', timestamp: T1 }] }],
      ['negative qty', { trades: [{ pair: 'BTC/USD', side: 'long', qty: -1, timestamp: T1 }] }],
      ['bad capital low', { starting_capital: 999, trades: [] }],
      ['bad capital high', { starting_capital: 100001, trades: [] }],
      ['too many trades', { trades: Array.from({ length: 501 }, () => ({ pair: 'BTC/USD', side: 'long', qty: 0.001, timestamp: T1 })) }],
    ];
    for (const [name, body] of cases) {
      const { env } = mockDb([authOnly()]);
      const res = await postBacktest(authed(body), env);
      expect(res.status, name).toBe(422);
    }
  });

  it('empty trades -> 200 flat curve at starting capital, nothing written', async () => {
    const { env, runs } = mockDb([authOnly()]);
    const res = await postBacktest(authed({ trades: [] }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.trades_submitted).toBe(0);
    expect(body.return_pct).toBe(0);
    // Timeframe anchors (from/to) frame the flat curve; all points at capital.
    expect(body.points.length).toBeGreaterThan(0);
    expect(body.points.every((p: { equity: number }) => p.equity === 10_000)).toBe(true);
    expect(body.summary).toContain('$10,000');
    expect(runs.length).toBe(0); // pure: no D1 writes
  });

  it('happy path fills from mocked history and writes nothing', async () => {
    const { env, runs } = mockDb([
      authOnly(),
      {
        match: (s) => s.includes('needs(ts)'),
        all: [
          { need_ts: T1 - 1, bid: 59950, ask: 60050 },
          { need_ts: T1, bid: 59950, ask: 60050 },
          { need_ts: T2, bid: 60950, ask: 61050 },
        ],
      },
    ]);
    const res = await postBacktest(
      authed({
        starting_capital: 100_000,
        trades: [
          { pair: 'BTC-USD', side: 'long', qty: 1, timestamp: T1 },
          { pair: 'BTC/USD', side: 'short', qty: 1, timestamp: T2 },
        ],
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.trades_submitted).toBe(2);
    expect(body.trades_filled).toBe(2);
    expect(body.trades[0].pair).toBe('BTC/USD'); // "-" form normalized
    expect(body.trades[0].status).toBe('filled');
    expect(body.trades[0].fill_price).toBeCloseTo(60050 * 1.0005, 6);
    expect(body.trades[1].fill_price).toBeCloseTo(60950 * 0.9995, 6);
    expect(body.return_pct).toBeGreaterThan(0);
    expect(typeof body.summary).toBe('string');
    expect(body.honesty.lookahead).toContain('at-or-before');
    expect(runs.length).toBe(0);
  });

  it('accepts a custom starting capital', async () => {
    const { env } = mockDb([authOnly()]);
    const res = await postBacktest(authed({ starting_capital: 25000, trades: [] }), env);
    const body = (await res.json()) as Record<string, any>;
    expect(body.starting_capital).toBe(25000);
    expect(body.points[0].equity).toBe(25000);
  });
});
