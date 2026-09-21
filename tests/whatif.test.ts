// The Pit — what-if counterfactual replay v1 tests (pure engine, synthetic data).
import { describe, it, expect } from 'vitest';
import {
  replayCounterfactual,
  runWhatIf,
  quoteAt,
  downsamplePoints,
  SKIP_WORST_MAX_FILLS,
  type WhatIfFill,
  type WhatIfQuote,
} from '../src/lib/whatif';

const T0 = 1_000_000;
const T1 = 2_000_000;
const T2 = 3_000_000;
const T3 = 4_000_000;
const T4 = 5_000_000;

function q(ts: number, mid: number): WhatIfQuote {
  return { ts, bid: mid - 50, ask: mid + 50 };
}

function limitFill(id: string, ts: number, pair: string, side: 'buy' | 'sell', qty: number, limit: number): WhatIfFill {
  return { id, ts, pair, side, qty, type: 'limit', limitPrice: limit };
}

function baseArgs(timeline: number[], fills: WhatIfFill[], pairQuotes: Array<[string, WhatIfQuote[]]>, capital = 1_000_000) {
  const quotesByPair = new Map<string, WhatIfQuote[]>();
  for (const [pair, qs] of pairQuotes) quotesByPair.set(pair, [...qs].sort((a, b) => a.ts - b.ts));
  return { timeline, fills, quotesByPair, startingCapital: capital, sizing: 1, stopLossPct: null, skipFillId: null };
}

const BTC = (mids: Array<[number, number]>) => mids.map(([ts, mid]) => q(ts, mid)) as WhatIfQuote[];

describe('quoteAt', () => {
  const quotes = BTC([[T1, 60000], [T3, 61000]]);
  it('returns exact hits, floors between quotes, null before the first', () => {
    expect(quoteAt(quotes, T1)!.bid).toBe(59950);
    expect(quoteAt(quotes, T2)!.bid).toBe(59950); // no lookahead: uses T1 quote
    expect(quoteAt(quotes, T4)!.bid).toBe(60950);
    expect(quoteAt(quotes, T1 - 1)).toBe(null);
  });
});

describe('replayCounterfactual', () => {
  it('k=1 reproduces the hand-computed curve (identity property)', () => {
    // 1 BTC @60000 limit on 1M capital; mids: 60k, 60k, 61k, 61k
    const quotes = BTC([[T0, 60000], [T1, 60000], [T2, 61000], [T3, 61000]]);
    const fills = [limitFill('f1', T1, 'BTC/USD', 'buy', 1, 60000)];
    const r = replayCounterfactual(baseArgs([T0, T1, T2, T3], fills, [['BTC/USD', quotes]]));
    expect(r.points).toEqual([
      { ts: T0, equity: 1_000_000 },
      { ts: T1, equity: 1_000_000 }, // filled at 60k: 940k cash + 1*60k
      { ts: T2, equity: 1_001_000 }, // 940k + 1*61k
      { ts: T3, equity: 1_001_000 },
    ]);
    expect(r.finalEquity).toBe(1_001_000);
    expect(r.fillsSkippedNoQuote).toBe(0);
  });

  it('sizing scales trade PnL linearly: (eq2 - C) === 2 * (eq1 - C)', () => {
    const quotes = BTC([[T0, 60000], [T1, 60000], [T2, 61000]]);
    const fills = [limitFill('f1', T1, 'BTC/USD', 'buy', 1, 60000)];
    const r1 = replayCounterfactual({ ...baseArgs([T0, T1, T2], fills, [['BTC/USD', quotes]]), sizing: 1 });
    const r2 = replayCounterfactual({ ...baseArgs([T0, T1, T2], fills, [['BTC/USD', quotes]]), sizing: 2 });
    expect(r2.finalEquity - 1_000_000).toBe(2 * (r1.finalEquity - 1_000_000));
    expect(r2.finalEquity).toBe(1_002_000);
  });

  it('tracks realized PnL on round trips', () => {
    const quotes: Array<[string, WhatIfQuote[]]> = [['BTC/USD', BTC([[T0, 60000], [T1, 60000], [T2, 66000], [T3, 66000]])]];
    const fills = [
      limitFill('f1', T1, 'BTC/USD', 'buy', 1, 60000),
      limitFill('f2', T2, 'BTC/USD', 'sell', 1, 66000),
    ];
    const r = replayCounterfactual(baseArgs([T0, T1, T2, T3], fills, quotes));
    expect(r.finalEquity).toBe(1_006_000);
    expect(r.realizedPnl).toBe(6000);
  });

  it('honors a stop-loss: flattens at the trigger and beats a keep-holding crash', () => {
    // 10 BTC @60000 (600k notional on 1M). Mids: 60k, 60k, 45k, 30k.
    const quotes = BTC([[T0, 60000], [T1, 60000], [T2, 45000], [T3, 30000]]);
    const fills = [limitFill('f1', T1, 'BTC/USD', 'buy', 10, 60000)];
    const base = [T0, T1, T2, T3];
    const noStop = replayCounterfactual(baseArgs(base, fills, [['BTC/USD', quotes]]));
    const stop = replayCounterfactual({ ...baseArgs(base, fills, [['BTC/USD', quotes]]), stopLossPct: 0.1 });
    // baseline: 400k cash + 10*30k = 700k; dd from 1M = 30%
    expect(noStop.finalEquity).toBe(700_000);
    // stop triggers at T2 (dd 15% >= 10%): flattens 10 BTC at bid*(1-5bps) = 44927.525
    expect(stop.finalEquity).toBeCloseTo(849_275.25, 6);
    expect(stop.stopsTriggered).toBe(1);
    expect(stop.finalEquity).toBeGreaterThan(noStop.finalEquity);
    const dd = (pts: { equity: number }[]) => {
      let peak = 0; let max = 0;
      for (const p of pts) { peak = Math.max(peak, p.equity); max = Math.max(max, (peak - p.equity) / peak); }
      return max;
    };
    expect(dd(stop.points)).toBeLessThan(dd(noStop.points));
  });

  it('a 100% stop-loss never triggers and equals the baseline', () => {
    const quotes = BTC([[T0, 60000], [T1, 60000], [T2, 30000]]);
    const fills = [limitFill('f1', T1, 'BTC/USD', 'buy', 1, 60000)];
    const base = baseArgs([T0, T1, T2], fills, [['BTC/USD', quotes]]);
    const a = replayCounterfactual(base);
    const b = replayCounterfactual({ ...base, stopLossPct: 1 });
    expect(b.points).toEqual(a.points);
    expect(b.stopsTriggered).toBe(0);
  });

  it('market fills use the touch-side quote plus 5 bps slippage', () => {
    const quotes = BTC([[T0, 60000], [T1, 60000]]);
    const buy: WhatIfFill = { id: 'f1', ts: T1, pair: 'BTC/USD', side: 'buy', qty: 1, type: 'market', limitPrice: null };
    const r = replayCounterfactual(baseArgs([T0, T1], [buy], [['BTC/USD', quotes]]));
    // ask = 60050, slippage x1.0005 -> cash = 1M - 60050*1.0005
    const expectedCash = 1_000_000 - 60050 * 1.0005;
    expect(r.finalEquity).toBeCloseTo(expectedCash + 60000, 6);
  });

  it('skips market fills with no historical quote instead of inventing prices', () => {
    const quotes = BTC([[T1, 60000]]);
    const fills: WhatIfFill[] = [
      { id: 'f1', ts: T0, pair: 'BTC/USD', side: 'buy', qty: 1, type: 'market', limitPrice: null }, // fill before any quote
    ];
    const r = replayCounterfactual(baseArgs([T0, T1], fills, [['BTC/USD', quotes]]));
    expect(r.fillsSkippedNoQuote).toBe(1);
    expect(r.fillsReplayed).toBe(0);
    expect(r.finalEquity).toBe(1_000_000);
  });

  it('empty fills give a flat line at starting capital', () => {
    const quotes = BTC([[T0, 60000], [T1, 61000]]);
    const r = replayCounterfactual(baseArgs([T0, T1], [], [['BTC/USD', quotes]]));
    expect(r.points).toEqual([{ ts: T0, equity: 1_000_000 }, { ts: T1, equity: 1_000_000 }]);
  });
});

describe('downsamplePoints', () => {
  it('keeps first and last, caps length', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ ts: i, equity: 1000 + i }));
    const d = downsamplePoints(pts, 400);
    expect(d.length).toBeLessThanOrEqual(400);
    expect(d[0]).toEqual({ t: pts[0].ts, equity: pts[0].equity });
    expect(d[d.length - 1]).toEqual({ t: pts[pts.length - 1].ts, equity: pts[pts.length - 1].equity });
    expect(d.length).toBe(400);
  });

  it('leaves short series alone', () => {
    const pts = [{ ts: 1, equity: 5 }];
    expect(downsamplePoints(pts, 400)).toEqual([{ t: 1, equity: 5 }]);
  });
});

describe('runWhatIf', () => {
  function input(capital = 1_000_000) {
    // f1, f2: buys @60k; price crashes to 24k then 12k — stop-loss and skip-worst both help.
    const pairQuotes: Array<[string, WhatIfQuote[]]> = [['BTC/USD', BTC([[T0, 60000], [T1, 60000], [T2, 60000], [T3, 24000], [T4, 12000]])]];
    const fills = [
      limitFill('f1', T1, 'BTC/USD', 'buy', 1, 60000),
      limitFill('f2', T2, 'BTC/USD', 'buy', 1, 60000),
    ];
    const quotesByPair = new Map<string, WhatIfQuote[]>(pairQuotes);
    const actualPoints = [
      { ts: T0, equity: capital },
      { ts: T1, equity: capital },
      { ts: T2, equity: capital - 120000 + 2 * 60000 }, // 1M
      { ts: T3, equity: capital - 120000 + 2 * 24000 }, // 928k
      { ts: T4, equity: capital - 120000 + 2 * 12000 }, // 904k
    ];
    return { startingCapital: capital, actualPoints, fills, quotesByPair, timeline: [T0, T1, T2, T3, T4] };
  }

  it('includes the 1.0x sizing baseline reproducing k=1 replay', () => {
    const { scenarios } = runWhatIf({ ...input(), sizings: [1], stopPcts: [], includeSkipWorst: false, maxPoints: 400 });
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].name).toBe('1x sizing');
    expect(scenarios[0].kind).toBe('sizing');
    expect(scenarios[0].return_pct).toBeCloseTo(-9.6, 9); // (904k-1M)/1M*100
  });

  it('stop-loss scenarios report stops and a summary names the best counterfactual', () => {
    const { scenarios, summary, actual } = runWhatIf({
      ...input(),
      sizings: [1],
      stopPcts: [0.05],
      includeSkipWorst: true,
      maxPoints: 400,
    });
    const baseline = scenarios.find((s) => s.name === '1x sizing')!;
    const stop = scenarios.find((s) => s.kind === 'stop_loss')!;
    expect(stop.name).toBe('5% stop-loss');
    expect(stop.stops_triggered).toBeGreaterThan(0);
    // 5% stop triggers at T3 (dd 7.2%): flattens at bid*(1-5bps)=23938.025 ->
    // 880k + 2*23938.025 = 927876.05, beats the crash to 904k.
    expect(stop.return_pct).toBeCloseTo(-7.212395, 6);
    expect(stop.return_pct).toBeGreaterThan(baseline.return_pct);
    const skip = scenarios.find((s) => s.kind === 'skip_worst')!;
    // skipping f1 leaves f2: 940k + 1*12k = 952k -> -4.8%
    expect(skip.return_pct).toBeCloseTo(-4.8, 9);
    expect(skip.name).toContain('skip worst trade');
    expect(actual.return_pct).toBeCloseTo(-9.6, 9);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain('%');
  });

  it('defers skip-worst past the fill cap instead of churning O(n^2)', () => {
    const fills = Array.from({ length: SKIP_WORST_MAX_FILLS + 1 }, (_, i) =>
      limitFill(`f${i}`, T1, 'BTC/USD', 'buy', 1, 60000));
    const { scenarios } = runWhatIf({
      ...input(),
      fills,
      sizings: [1],
      stopPcts: [],
      includeSkipWorst: true,
      maxPoints: 400,
    });
    const skip = scenarios.find((s) => s.kind === 'skip_worst')!;
    expect(skip.note).toContain('exceeds');
    expect(skip.points).toEqual([]);
  });
});

// --- route auth/ownership -----------------------------------------------------

describe('getWhatIf route', () => {
  // Minimal inline mock D1 (mirrors tests/webhooks.test.ts helpers).
  type Handler = {
    match: (sql: string) => boolean;
    first?: unknown | ((params: unknown[]) => unknown);
    all?: unknown[] | ((params: unknown[]) => unknown[]);
  };
  function mockDb(handlers: Handler[]) {
    const find = (sql: string) => handlers.find((x) => x.match(sql)) ?? { match: () => true };
    const stmt = (sql: string) => {
      const h = find(sql) as Handler;
      const bound = (...p: unknown[]) => ({
        all: async () => ({
          results: typeof h.all === 'function' ? (h.all as (x: unknown[]) => unknown[])(p) : (h.all ?? []),
        }),
        first: async () =>
          typeof h.first === 'function' ? (h.first as (x: unknown[]) => unknown)(p) : (h.first ?? null),
        run: async () => ({ success: true }),
      });
      const unbound = bound();
      return { bind: bound, all: unbound.all, first: unbound.first, run: unbound.run };
    };
    const db = { prepare: (sql: string) => stmt(sql), batch: async () => [] as unknown[] };
    return { DB: db, ADMIN_SECRET: 'x' } as unknown as import('../src/lib/types').Env;
  }
  const agent = { id: 'ag_1', email: 'a@b.c', name: 'bot', status: 'active' };
  const authHandlers: Handler[] = [
    { match: (s) => s.includes('FROM agents WHERE api_key_hash'), first: agent },
  ];
  const authed = (id: string) =>
    new Request(`https://the-pit.twj.workers.dev/api/v1/entries/${id}/whatif`, {
      headers: { 'X-API-Key': 'pit_testkey' },
    });

  it('401 without an API key', async () => {
    const { getWhatIf } = await import('../src/routes/whatif');
    const env = mockDb([]);
    const res = await getWhatIf(
      new Request('https://the-pit.twj.workers.dev/api/v1/entries/nope/whatif'),
      env,
      'nope',
    );
    expect(res.status).toBe(401);
  });

  it('404 for an unknown entry (no data created)', async () => {
    const { getWhatIf } = await import('../src/routes/whatif');
    const env = mockDb([...authHandlers, { match: (s) => s.includes('FROM season_entries'), first: null }]);
    const res = await getWhatIf(authed('entry_nope'), env, 'entry_nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('entry_not_found');
  });

  it('403 for another agent\u2019s entry', async () => {
    const { getWhatIf } = await import('../src/routes/whatif');
    const env = mockDb([
      ...authHandlers,
      {
        match: (s) => s.includes('FROM season_entries'),
        first: { id: 'e2', season_id: 's1', agent_id: 'ag_OTHER', starting_capital: 10000, entered_at: 1 },
      },
    ]);
    const res = await getWhatIf(authed('e2'), env, 'e2');
    expect(res.status).toBe(403);
  });

  it('200 with no fills: stable shape and the no-fills summary', async () => {
    const { getWhatIf } = await import('../src/routes/whatif');
    const env = mockDb([
      ...authHandlers,
      {
        match: (s) => s.includes('FROM season_entries'),
        first: { id: 'e1', season_id: 's1', agent_id: 'ag_1', starting_capital: 10000, entered_at: 1000 },
      },
      { match: (s) => s.includes('FROM orders'), all: [] },
      { match: (s) => s.includes('FROM equity_snapshots'), all: [{ ts: 2000, equity: 10100 }] },
    ]);
    const res = await getWhatIf(authed('e1'), env, 'e1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fills: number;
      scenarios: unknown[];
      summary: string;
      actual: { return_pct: number; points: Array<{ t: number; equity: number }> };
    };
    expect(body.fills).toBe(0);
    expect(body.scenarios).toEqual([]);
    expect(body.summary).toContain('No filled orders yet');
    expect(body.actual.return_pct).toBeCloseTo(1, 9);
    // first and last points preserved by downsampling
    expect(body.actual.points[0].t).toBe(1000);
    expect(body.actual.points[body.actual.points.length - 1].t).toBe(2000);
  });
});
