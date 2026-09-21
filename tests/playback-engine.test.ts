// The Pit — SimPlayback engine unit tests.
//
// The engine is a self-contained, DOM-free section of the /simulate page
// script (window.__simEngine). These tests load the real page in jsdom and
// drive the pure functions directly, including a no-lookahead cross-check:
// the "at this moment" panel at a trade timestamp must exactly match the
// backend replay's own equity_after for that trade.

import { describe, it, expect, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { simulatePage } from '../src/pages';
import { postSimulate, resetSimulateRateLimit } from '../src/routes/simulate';
import { runBacktestReplay } from '../src/lib/backtest';
import { applyFill } from '../src/lib/engine';
import type { Env } from '../src/lib/types';

const MN = Date.UTC(2025, 8, 20);
const MX = Date.UTC(2026, 8, 20);

function mockDb() {
  const stmt = (sql: string) => {
    const bound = (..._p: unknown[]) => ({
      all: async () => {
        if (sql.includes('WITH needs(ts)')) {
          const hits = sql.match(/\(\d+\)/g) ?? [];
          return {
            results: hits.map((x) => {
              const ts = Number(x.slice(1, -1));
              const mid = 60000 + ((ts / 3_600_000) % 24) * 10;
              return { need_ts: ts, bid: mid - 50, ask: mid + 50 };
            }),
          };
        }
        return { results: [] };
      },
      first: async () => {
        if (sql.includes('MIN(ts)')) return { mn: MN, mx: MX };
        return null;
      },
      run: async () => ({ success: true }),
    });
    return { bind: bound, all: () => bound().all(), first: () => bound().first(), run: () => bound().run() };
  };
  return { DB: { prepare: stmt }, ADMIN_SECRET: 'x' } as unknown as Env;
}

let wins: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const w of wins) w.close();
  wins = [];
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadEngine(): Promise<any> {
  const env = mockDb();
  const html = await (await simulatePage(env)).text();
  const dom = new JSDOM(html, {
    url: 'https://the-pit.twj.workers.dev/simulate',
    runScripts: 'dangerously',
  });
  wins.push(dom.window);
  const eng = (dom.window as unknown as Record<string, unknown>).__simEngine;
  expect(eng).toBeTruthy();
  return eng;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cannedReplay(): Promise<any> {
  resetSimulateRateLimit();
  const env = mockDb();
  const span = MX - MN;
  const specs = [0.18, 0.4, 0.62, 0.85].map((f, i) => ({
    pair: 'BTC/USD',
    side: i % 2 === 0 ? 'long' : ('short' as const),
    notional: 2000 - i * 400,
    timestamp: Math.round(MN + span * f),
  }));
  const req = new Request('https://the-pit.twj.workers.dev/api/v1/simulate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ starting_capital: 10000, trades: specs }),
  });
  const res = await postSimulate(req, env);
  expect(res.status).toBe(200);
  return res.json();
}

describe('SimPlayback engine', () => {
  it('buildGrid: sorted, unique, clamped to [from,to], includes trade times and endpoints', async () => {
    const E = await loadEngine();
    const market = { 'BTC/USD': [{ t: 100, price: 1 }, { t: 200, price: 2 }, { t: 200, price: 2 }, { t: 50, price: 0 }] };
    const points = [{ t: 150, equity: 5 }];
    const trades = [{ ts: 175 }, { ts: 9999 }];
    const grid = E.buildGrid(market, points, trades, 100, 300);
    expect(grid).toEqual([100, 150, 175, 200, 300]);
  });

  it('stepOnGrid: steps one point, snaps, clamps at both ends', async () => {
    const E = await loadEngine();
    const grid = [10, 20, 30];
    expect(E.stepOnGrid(grid, 20, 1)).toBe(30);
    expect(E.stepOnGrid(grid, 20, -1)).toBe(10);
    expect(E.stepOnGrid(grid, 30, 1)).toBe(30); // clamp
    expect(E.stepOnGrid(grid, 10, -1)).toBe(10); // clamp
    expect(E.stepOnGrid(grid, 25, 1)).toBe(30); // snap to 20, then step
    expect(E.stepOnGrid(grid, 25, -1)).toBe(10);
    expect(E.stepOnGrid([], 25, 1)).toBe(25); // empty grid: no-op
  });

  it('jumpEvent: strictly before/after, null past the ends', async () => {
    const E = await loadEngine();
    const ev = [{ ts: 10, index: 0 }, { ts: 20, index: 1 }, { ts: 30, index: 2 }];
    expect(E.jumpEvent(20, 1, ev)).toBe(30);
    expect(E.jumpEvent(20, -1, ev)).toBe(10);
    expect(E.jumpEvent(15, 1, ev)).toBe(20);
    expect(E.jumpEvent(15, -1, ev)).toBe(10);
    expect(E.jumpEvent(30, 1, ev)).toBeNull();
    expect(E.jumpEvent(10, -1, ev)).toBeNull();
    expect(E.jumpEvent(20, 1, [])).toBeNull();
  });

  it('priceAt: nearest at-or-before, never after', async () => {
    const E = await loadEngine();
    const s = [{ t: 10, price: 100 }, { t: 20, price: 200 }];
    expect(E.priceAt(s, 15).price).toBe(100);
    expect(E.priceAt(s, 20).price).toBe(200);
    expect(E.priceAt(s, 5)).toBeNull();
  });

  it('markAt: exact at market points, trend-continuation between them, null before the first point, never leaks the future', async () => {
    const E = await loadEngine();
    const s = [{ t: 100, price: 100 }, { t: 200, price: 120 }];
    expect(E.markAt(s, 100)).toBe(100);
    expect(E.markAt(s, 200)).toBe(120);
    expect(E.markAt(s, 150)).toBeCloseTo(110, 9); // midpoint of the last historical segment
    expect(E.markAt(s, 50)).toBeNull();
    // A point stamped after T can never move the mark at T.
    const s2 = [...s, { t: 300, price: 1000 }];
    expect(E.markAt(s2, 150)).toBeCloseTo(110, 9);
    expect(E.markAt(s2, 200)).toBe(120);
  });

  it('client ledger mirrors the backend replay accounting exactly (synthetic quotes, open/reduce/flip)', async () => {
    const E = await loadEngine();
    const quotes = [100, 110, 105, 120].map((mid, i) => ({
      ts: (i + 1) * 1000,
      bid: mid - 1,
      ask: mid + 1,
    }));
    const trades = [
      { pair: 'BTC/USD', side: 'long' as const, qty: 2, notional: null, ts: 1000 },
      { pair: 'BTC/USD', side: 'short' as const, qty: 1, notional: null, ts: 3000 }, // partial reduce
      { pair: 'BTC/USD', side: 'short' as const, qty: 3, notional: null, ts: 4000 }, // flip through to net short
    ];
    const timeline = [500, 1000, 2000, 3000, 4000];
    const res = runBacktestReplay({
      trades,
      quotesByPair: new Map([['BTC/USD', quotes]]),
      timeline,
      startingCapital: 10000,
    });
    expect(res.trades.filter((t) => t.status === 'filled').length).toBe(3);
    // Client ledger built from the backend's own trade results (fill prices
    // already embed touch-side + 5bps slippage).
    const ledger = E.buildLedger(res.trades, 10000);
    const market = { 'BTC/USD': quotes.map((q) => ({ t: q.ts, price: (q.bid + q.ask) / 2 })) };
    // Equity matches the backend curve at every evaluated timestamp.
    for (const pt of res.points) {
      expect(E.equityAt(ledger, market, pt.ts)).toBeCloseTo(pt.equity, 9);
    }
    // equity_after parity at each fill.
    for (const t of res.trades) {
      if (t.status !== 'filled') continue;
      expect(E.equityAt(ledger, market, t.ts)).toBeCloseTo(t.equity_after, 9);
    }
    // Final equity agrees with the backend.
    expect(E.equityAt(ledger, market, 4000)).toBeCloseTo(res.finalEquity, 9);
  });

  it('equity is continuous between fills: Δequity == Σ qty×Δmark, flat iff the market is flat', async () => {
    const E = await loadEngine();
    const market = {
      'BTC/USD': [
        { t: 100, price: 100 },
        { t: 200, price: 110 },
        { t: 300, price: 105 },
      ],
    };
    const trades = [
      { status: 'filled', ts: 100, index: 0, pair: 'BTC/USD', side: 'long', qty: 2, fill_price: 100 },
    ];
    const ledger = E.buildLedger(trades, 1000); // cash = 800 after the fill
    const e100 = E.equityAt(ledger, market, 100);
    const e150 = E.equityAt(ledger, market, 150);
    const e200 = E.equityAt(ledger, market, 200);
    const e250 = E.equityAt(ledger, market, 250);
    expect(e100).toBeCloseTo(1000, 9);
    expect(e150 - e100).toBeCloseTo(2 * (105 - 100), 9);
    expect(e200 - e150).toBeCloseTo(2 * (110 - 105), 9);
    expect(e250 - e200).toBeCloseTo(2 * (107.5 - 110), 9);
    // Flat market -> flat equity.
    const flat = { 'BTC/USD': [{ t: 100, price: 100 }, { t: 200, price: 100 }] };
    expect(E.equityAt(ledger, flat, 199)).toBeCloseTo(E.equityAt(ledger, flat, 100), 9);
  });

  it('equityAt never sees fills or market points after T; rejected trades contribute nothing', async () => {
    const E = await loadEngine();
    const market = { 'BTC/USD': [{ t: 100, price: 100 }, { t: 200, price: 110 }] };
    const trades = [
      { status: 'filled', ts: 100, index: 0, pair: 'BTC/USD', side: 'long', qty: 1, fill_price: 100 },
      { status: 'filled', ts: 900, index: 1, pair: 'BTC/USD', side: 'long', qty: 100, fill_price: 50 },
      { status: 'rejected', ts: 150, index: 2, pair: 'BTC/USD', side: 'short', qty: 5, fill_price: null },
    ];
    const ledger = E.buildLedger(trades, 1000);
    // At T=150: cash 900, mark 105 -> 1005. The T=900 fill and the rejected trade are invisible.
    expect(E.equityAt(ledger, market, 150)).toBeCloseTo(1005, 9);
    // A market point stamped after T cannot move the mark at T.
    const withFuture = { 'BTC/USD': [{ t: 100, price: 100 }, { t: 200, price: 110 }, { t: 300, price: 100000 }] };
    expect(E.equityAt(ledger, withFuture, 150)).toBeCloseTo(1005, 9);
    // Before any fill: starting capital.
    expect(E.equityAt(ledger, market, 50)).toBe(1000);
    // Rejected trade changes nothing vs the ledger without it.
    const clean = E.buildLedger([trades[0]], 1000);
    expect(E.equityAt(ledger, market, 200)).toBeCloseTo(E.equityAt(clean, market, 200), 9);
  });

  it('tradeStateAt: upcoming before fill, open after, unrealized long/short math', async () => {
    const E = await loadEngine();
    const market = { 'BTC/USD': [{ t: 100, price: 90 }, { t: 200, price: 110 }] };
    const long = { status: 'filled', ts: 100, side: 'long', pair: 'BTC/USD', qty: 2, fill_price: 100 };
    const short = { status: 'filled', ts: 100, side: 'short', pair: 'BTC/USD', qty: 2, fill_price: 100 };
    expect(E.tradeStateAt(long, 50, market).status).toBe('upcoming');
    expect(E.tradeStateAt(long, 50, market).unrealized).toBeNull();
    const stL = E.tradeStateAt(long, 200, market);
    expect(stL.status).toBe('open');
    expect(stL.unrealized).toBeCloseTo(2 * (110 - 100), 9); // long gains as price rises
    const stS = E.tradeStateAt(short, 200, market);
    expect(stS.unrealized).toBeCloseTo(-2 * (110 - 100), 9); // short loses
    const rej = { status: 'rejected', ts: 100, side: 'long', pair: 'BTC/USD', qty: 1, fill_price: null };
    expect(E.tradeStateAt(rej, 200, market).status).toBe('rejected');
  });

  it('netPositions matches engine.applyFill netting (open/increase/reduce/flip)', async () => {
    const E = await loadEngine();
    const trades = [
      { status: 'filled', ts: 10, index: 0, pair: 'BTC/USD', side: 'long', qty: 3, fill_price: 100 },
      { status: 'filled', ts: 20, index: 1, pair: 'BTC/USD', side: 'long', qty: 1, fill_price: 110 },
      { status: 'filled', ts: 30, index: 2, pair: 'BTC/USD', side: 'short', qty: 2, fill_price: 120 },
      { status: 'filled', ts: 40, index: 3, pair: 'BTC/USD', side: 'short', qty: 5, fill_price: 130 },
    ];
    const market = { 'BTC/USD': [{ t: 40, price: 125 }] };
    // Reference: applyFill from the real engine, same order.
    let pos = { qty: 0, avgPrice: 0 };
    for (const t of trades) {
      const r = applyFill(pos, t.side === 'long' ? 'buy' : 'sell', t.qty, t.fill_price);
      pos = { qty: r.qty, avgPrice: r.avgPrice };
    }
    const nets = E.netPositions(40, trades, market);
    expect(nets.length).toBe(1);
    expect(nets[0].qty).toBeCloseTo(pos.qty, 9);
    expect(nets[0].avgPrice).toBeCloseTo(pos.avgPrice, 9);
    expect(nets[0].unrealized).toBeCloseTo(pos.qty * (125 - pos.avgPrice), 9);
    // Before the first fill: no positions.
    expect(E.netPositions(5, trades, market)).toEqual([]);
  });

  it('panelAt on a real API-shaped replay: fill-time parity within market-data tolerance, breathing between fills', async () => {
    const E = await loadEngine();
    const j = await cannedReplay();
    const ledger = E.buildLedger(j.trades, j.starting_capital);
    const grid = E.buildGrid(j.market, j.points, j.trades, j.timeframe.from, j.timeframe.to);
    const curve = E.equityCurve(grid, ledger, j.market);
    const data = { ledger, curve, cap: j.starting_capital, market: j.market };
    for (const t of j.trades) {
      if (t.status !== 'filled') continue;
      const p = E.panelAt(t.ts, data);
      // Client marks come from the downsampled market series while the backend
      // marked at full-resolution quotes — parity within a small tolerance.
      expect(Math.abs(p.equity - t.equity_after)).toBeLessThan(50);
      // P&L is consistent with equity.
      expect(p.pnl).toBeCloseTo(p.equity - j.starting_capital, 9);
      // Drawdown never negative, never exceeds 100%.
      expect(p.drawdown).toBeGreaterThanOrEqual(0);
      expect(p.drawdown).toBeLessThanOrEqual(1);
    }
    // The panel breathes between fills: across adjacent grid points with no
    // fill between them, equity must move when the market moves (this was the
    // reported bug — numbers sat flat until the next trade).
    const fillTs = new Set(
      j.trades.filter((t: { status: string }) => t.status === 'filled').map((t: { ts: number }) => t.ts),
    );
    let moved = 0;
    for (let i = 1; i < grid.length && moved < 5; i++) {
      const a = grid[i - 1];
      const b = grid[i];
      if ([...fillTs].some((ts) => (ts as number) > a && (ts as number) <= b)) continue; // a fill lands here
      const ea = E.panelAt(a, data).equity;
      const eb = E.panelAt(b, data).equity;
      // Wiring identity: panel equity is the ledger equity at T.
      expect(eb - ea).toBeCloseTo(E.equityAt(ledger, j.market, b) - E.equityAt(ledger, j.market, a), 6);
      if (Math.abs(eb - ea) > 1e-9) moved++;
    }
    expect(moved).toBeGreaterThan(0);
    // No-lookahead: appending a future market point cannot change the panel at T.
    const midT = Math.round((j.timeframe.from + j.timeframe.to) / 2);
    const before = E.panelAt(midT, data);
    const doctored = {
      ...j.market,
      'BTC/USD': [...j.market['BTC/USD'], { t: j.timeframe.to + 1, price: 1e9 }],
    };
    const after = E.panelAt(midT, { ledger, curve, cap: j.starting_capital, market: doctored });
    expect(after.equity).toBeCloseTo(before.equity, 9);
    expect(after.prices['BTC/USD']).toBeCloseTo(before.prices['BTC/USD'], 9);
  });

  it('revealX: the render-path no-lookahead contract — the clip rect ends at the playhead X', async () => {
    const E = await loadEngine();
    // from=0, to=100000, w=800: pad=60000, x0=-60000, x1=160000, inner width 724.
    expect(E.revealX(0, 0, 100000, 800)).toBeCloseTo(209.4545, 3);
    expect(E.revealX(50000, 0, 100000, 800)).toBeCloseTo(374, 9);
    expect(E.revealX(100000, 0, 100000, 800)).toBeCloseTo(538.5454, 3);
    // The clip at the window end stops before the right label gutter (w-64):
    // axis labels live outside the revealed data region.
    expect(E.revealX(100000, 0, 100000, 800)).toBeLessThan(800 - 64);
    // Monotonic: the reveal rect can only ever extend as T advances, so the
    // prerendered full series is never exposed ahead of the playhead.
    let prev = -Infinity;
    for (const T of [0, 25000, 50000, 75000, 100000]) {
      const x = E.revealX(T, 0, 100000, 800);
      expect(x).toBeGreaterThan(prev);
      prev = x;
    }
    // A wider chart keeps the same mapping shape (scales with w).
    expect(E.revealX(50000, 0, 100000, 1600)).toBeCloseTo(12 + (110000 / 220000) * (1600 - 76), 6);
  });

  it('playMs scales with speed and floors at 2s; fmtElapsed formats', async () => {
    const E = await loadEngine();
    expect(E.playMs(0, 45000, 1)).toBe(45000);
    expect(E.playMs(0, 45000, 2)).toBe(22500);
    expect(E.playMs(0, 45000, 16)).toBe(2812.5);
    expect(E.playMs(0, 1000, 64)).toBe(2000); // floored
    expect(E.fmtElapsed(0)).toBe('T+0m 0s');
    expect(E.fmtElapsed(90_000)).toBe('T+1m 30s');
    expect(E.fmtElapsed(3_700_000)).toBe('T+1h 1m');
    expect(E.fmtElapsed(200_000_000)).toBe('T+2d 7h');
  });
});
