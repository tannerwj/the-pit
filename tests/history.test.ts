// The Pit — history backfill tests (pure helpers + admin route, mock D1, stubbed fetch).
import { describe, it, expect, afterEach, vi } from 'vitest';
// @ts-ignore: node builtins have no type declarations in this tsconfig (workers-types only)
import { readFileSync } from 'node:fs';
// @ts-ignore: node builtins have no type declarations in this tsconfig (workers-types only)
import { join, dirname } from 'node:path';
// @ts-ignore: node builtins have no type declarations in this tsconfig (workers-types only)
import { fileURLToPath } from 'node:url';
import {
  normalizeDbPair,
  coinbaseProductId,
  candlesUrl,
  parseCandles,
  backfillWindows,
  COINBASE_MAX_CANDLES,
  BACKFILL_SOURCE,
  evenTimestamps,
  MAX_MARKET_POINTS,
} from '../src/lib/history';
import { backfillHistory } from '../src/routes/history';
import type { Env } from '../src/lib/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('history helpers', () => {
  it('normalizeDbPair accepts "-" and "/" forms, case-insensitive', () => {
    expect(normalizeDbPair('BTC-USD')).toBe('BTC/USD');
    expect(normalizeDbPair('btc/usd')).toBe('BTC/USD');
    expect(normalizeDbPair('ETH/USD')).toBe('ETH/USD');
    expect(normalizeDbPair('NOPE/USD')).toBe(null);
    expect(normalizeDbPair(42)).toBe(null);
    expect(normalizeDbPair(null)).toBe(null);
  });

  it('coinbaseProductId maps DB form to Coinbase id', () => {
    expect(coinbaseProductId('BTC/USD')).toBe('BTC-USD');
  });

  it('candlesUrl targets the hourly Coinbase endpoint', () => {
    const url = candlesUrl('BTC/USD', 1_000, 2_000);
    expect(url).toContain('/products/BTC-USD/candles');
    expect(url).toContain('granularity=3600');
    expect(url).toContain(encodeURIComponent(new Date(1_000).toISOString()));
  });

  it('parseCandles maps newest-first rows to ascending bid=ask=close quotes', () => {
    // [time, low, high, open, close, volume]
    const raw = [
      [2000, 59, 61, 60, 60.5, 10],
      [1000, 58, 59, 58.5, 58.5, 9],
      ['bad'],
      [3000, 60, 62, 61, -5, 1], // negative close dropped
      [4000, 60, 62, 61, 61, 1],
    ];
    const out = parseCandles(raw);
    expect(out).toHaveLength(3);
    expect(out.map((q) => q.ts)).toEqual([1_000_000, 2_000_000, 4_000_000]);
    expect(out[0]).toEqual({ ts: 1_000_000, bid: 58.5, ask: 58.5 });
    expect(parseCandles('nope')).toEqual([]);
  });

  it('backfillWindows covers the range in <=300h windows, contiguous, oldest-first', () => {
    const end = 1_758_400_000_000;
    const months = 12;
    const ws = backfillWindows(end, months);
    // 12 * 30.4375d = ~8766h -> 30 windows of 300h (last one partial).
    expect(ws.length).toBe(30);
    for (const w of ws) {
      expect(w.end - w.start).toBeLessThanOrEqual(COINBASE_MAX_CANDLES * 3_600_000);
    }
    expect(ws[ws.length - 1].end).toBe(end);
    expect(ws[0].start).toBe(end - Math.round(months * 30.4375 * 86_400_000));
    for (let i = 1; i < ws.length; i++) {
      expect(ws[i].start).toBe(ws[i - 1].end); // contiguous, no gaps/overlaps
    }
  });

  it('migration 0004 adds the UNIQUE index that makes backfill idempotent', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(dir, '..', 'migrations', '0004_history.sql'), 'utf8');
    expect(sql).toContain('idx_quotes_pair_ts_source');
    expect(sql).toContain('UNIQUE');
  });
});

// ---------------------------------------------------------------------------
// Admin route (mock D1 with INSERT OR IGNORE semantics, stubbed fetch)
// ---------------------------------------------------------------------------

function mockDb(liveMinTs: number | null): { env: Env; inserted: Map<string, number[]> } {
  const inserted = new Map<string, number[]>();
  const stmt = (sql: string) => {
    const bound =
      (...p: unknown[]) =>
      ({
        _sql: sql,
        _params: p,
        all: async () => ({
          results: sql.includes('MIN(ts)') ? [{ ts: liveMinTs }] : [],
        }),
        first: async () => null,
        run: async () => ({ success: true }),
      }) as unknown;
    return { bind: bound };
  };
  const db = {
    prepare: stmt,
    batch: async (stmts: Array<{ _sql: string; _params: unknown[] }>) => {
      const out: Array<{ success: boolean; meta: { changes: number } }> = [];
      for (const s of stmts) {
        const [pair, ts, bid, ask, source] = s._params as [string, number, number, number, string];
        const key = `${pair}|${ts}|${source}`;
        if (!s._sql.includes('INSERT OR IGNORE')) {
          throw new Error('backfill must use INSERT OR IGNORE');
        }
        if (inserted.has(key)) {
          out.push({ success: true, meta: { changes: 0 } });
        } else {
          inserted.set(key, [ts, bid, ask]);
          out.push({ success: true, meta: { changes: 1 } });
        }
      }
      return out;
    },
  };
  return { env: { DB: db, ADMIN_SECRET: 'x' } as unknown as Env, inserted };
}

const LIVE_MIN = 1_758_400_000_000;

/** Stub fetch to return 2 deterministic hourly candles per window. */
function stubCandles() {
  vi.stubGlobal(
    'fetch',
    async (url: string) => {
      const u = new URL(url);
      const start = Date.parse(u.searchParams.get('start')!);
      const mk = (ms: number, close: number) => [ms / 1000, close - 1, close + 1, close, close, 5];
      return {
        ok: true,
        json: async () => [mk(start, 60000), mk(start + 3_600_000, 60100)],
      };
    },
  );
}

const adminReq = (body: unknown, qs = '') =>
  new Request(`https://the-pit.twj.workers.dev/api/v1/admin/history/backfill${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /api/v1/admin/history/backfill', () => {
  it('backfills one pair and is idempotent on re-run', async () => {
    stubCandles();
    const { env, inserted } = mockDb(LIVE_MIN);
    const first = await backfillHistory(adminReq({ pair: 'BTC/USD', months: 1 }), env);
    expect(first.status).toBe(200);
    const b1 = (await first.json()) as Record<string, any>;
    expect(b1.pair).toBe('BTC/USD');
    expect(b1.source).toBe(BACKFILL_SOURCE);
    expect(b1.range.to).toBe(LIVE_MIN); // ends where live quotes begin
    expect(b1.candles_fetched).toBe(6); // 3 windows x 2 candles
    expect(b1.rows_inserted).toBe(6);
    expect(inserted.size).toBe(6);
    // All rows land before the live era (no overlap with live quotes).
    for (const [, [ts]] of inserted) expect(ts).toBeLessThan(LIVE_MIN);

    // Re-run: nothing new is inserted.
    const second = await backfillHistory(adminReq({ pair: 'BTC/USD', months: 1 }), env);
    const b2 = (await second.json()) as Record<string, any>;
    expect(b2.candles_fetched).toBe(6);
    expect(b2.rows_inserted).toBe(0);
    expect(inserted.size).toBe(6);
  });

  it('accepts "-" pair form and query-string params', async () => {
    stubCandles();
    const { env } = mockDb(LIVE_MIN);
    const res = await backfillHistory(adminReq('', '?pair=eth-usd&months=1'), env);
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, any>;
    expect(b.pair).toBe('ETH/USD');
  });

  it('422 on bad pair or months', async () => {
    stubCandles();
    const { env } = mockDb(LIVE_MIN);
    for (const body of [{ pair: 'NOPE/USD' }, {}, { pair: 'BTC/USD', months: 0 }, { pair: 'BTC/USD', months: 25 }, { pair: 'BTC/USD', end: 'soon' }]) {
      const res = await backfillHistory(adminReq(body), env);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });

  it('502 when Coinbase errors (partial progress is kept; re-run resumes)', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, json: async () => [] }));
    const { env } = mockDb(LIVE_MIN);
    const res = await backfillHistory(adminReq({ pair: 'BTC/USD', months: 1 }), env);
    expect(res.status).toBe(502);
    const b = (await res.json()) as Record<string, any>;
    expect(b.error.code).toBe('coinbase_error');
  });
});

describe('evenTimestamps', () => {
  it('includes both endpoints, ascending, bounded by maxPoints', () => {
    const ts = evenTimestamps(1_000, 2_000, 5);
    expect(ts).toEqual([1000, 1250, 1500, 1750, 2000]);
    const year = evenTimestamps(0, 365 * 86400_000, MAX_MARKET_POINTS);
    expect(year.length).toBeLessThanOrEqual(MAX_MARKET_POINTS);
    expect(year[0]).toBe(0);
    expect(year[year.length - 1]).toBe(365 * 86400_000);
    for (let i = 1; i < year.length; i++) expect(year[i]).toBeGreaterThan(year[i - 1]);
  });

  it('returns [] for degenerate inputs', () => {
    expect(evenTimestamps(5_000, 5_000, 600)).toEqual([]);
    expect(evenTimestamps(6_000, 5_000, 600)).toEqual([]);
    expect(evenTimestamps(NaN, 5_000, 600)).toEqual([]);
    expect(evenTimestamps(1_000, 2_000, 0)).toEqual([]);
  });
});
