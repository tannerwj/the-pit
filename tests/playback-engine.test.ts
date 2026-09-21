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

  it('priceAt/equityAt: nearest at-or-before, never after', async () => {
    const E = await loadEngine();
    const s = [{ t: 10, price: 100 }, { t: 20, price: 200 }];
    expect(E.priceAt(s, 15).price).toBe(100);
    expect(E.priceAt(s, 20).price).toBe(200);
    expect(E.priceAt(s, 5)).toBeNull();
    const pts = [{ t: 10, equity: 1000 }, { t: 20, equity: 1100 }];
    expect(E.equityAt(pts, 15, 999)).toBe(1000);
    expect(E.equityAt(pts, 5, 999)).toBe(999); // before first point: starting capital
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

  it('panelAt at a trade timestamp exactly matches the backend replay equity_after (no lookahead)', async () => {
    const E = await loadEngine();
    const j = await cannedReplay();
    const data = { points: j.points, cap: j.starting_capital, trades: j.trades, market: j.market };
    for (const t of j.trades) {
      if (t.status !== 'filled') continue;
      const p = E.panelAt(t.ts, data);
      // The backend computed equity_after with the same no-lookahead quotes.
      expect(p.equity).toBeCloseTo(t.equity_after, 6);
      // P&L is consistent with equity.
      expect(p.pnl).toBeCloseTo(p.equity - j.starting_capital, 9);
      // Drawdown never negative, never exceeds 100%.
      expect(p.drawdown).toBeGreaterThanOrEqual(0);
      expect(p.drawdown).toBeLessThanOrEqual(1);
    }
    // Mid-replay scrub: equity equals the last curve point at-or-before T.
    const midT = Math.round((j.timeframe.from + j.timeframe.to) / 2);
    const p = E.panelAt(midT, data);
    const pts = j.points.filter((pt: { t: number }) => pt.t <= midT);
    expect(p.equity).toBeCloseTo(pts[pts.length - 1].equity, 9);
    // Prices never come from the future: last market point at-or-before T.
    const series = j.market['BTC/USD'];
    const mpts = series.filter((m: { t: number }) => m.t <= midT);
    expect(p.prices['BTC/USD']).toBeCloseTo(mpts[mpts.length - 1].price, 9);
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
