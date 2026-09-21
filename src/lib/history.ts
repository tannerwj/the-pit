// The Pit — historical market data helpers.
//
// Two eras of history live in the `quotes` table, distinguished by `source`:
//   - 'coinbase'           — live 1-minute bid/ask, collected since 2026-09-20
//   - 'coinbase-backfill'  — hourly Coinbase candles from before collection
//                            started, stored with bid=ask=close (public
//                            historical candles carry no bid/ask spread)
//
// The backfill ends where live collection begins, so the two eras form one
// continuous timeline: nearest-quote-at-or-before queries (candles endpoint,
// what-if replay, backtest) just work.

import type { Env } from './types';
import { q } from './db';
import { SUPPORTED_PAIRS } from './leagues';

export const BACKFILL_SOURCE = 'coinbase-backfill';
export const LIVE_SOURCE = 'coinbase';
/** Coinbase serves at most 300 candles per /candles request. */
export const COINBASE_MAX_CANDLES = 300;
/** Backfill granularity: hourly. */
export const BACKFILL_GRANULARITY_SECONDS = 3600;

export interface HistoryQuote {
  ts: number;
  bid: number;
  ask: number;
}

/** One point of a downsampled market-price series for charting. */
export interface MarketPoint {
  t: number;
  price: number;
}

/** Upper bound on market-chart points per pair in a simulate/backtest response. */
export const MAX_MARKET_POINTS = 600;

/** Normalize "BTC-USD" / "btc/usd" / "BTC/USD" to DB form, or null. */
export function normalizeDbPair(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const db = raw.replace(/-/g, '/').toUpperCase();
  return (SUPPORTED_PAIRS as readonly string[]).includes(db) ? db : null;
}

/** DB pair "BTC/USD" -> Coinbase product id "BTC-USD". */
export function coinbaseProductId(dbPair: string): string {
  return dbPair.replace('/', '-');
}

export function candlesUrl(
  dbPair: string,
  startMs: number,
  endMs: number,
): string {
  const params = new URLSearchParams({
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    granularity: String(BACKFILL_GRANULARITY_SECONDS),
  });
  return `https://api.exchange.coinbase.com/products/${coinbaseProductId(dbPair)}/candles?${params}`;
}

/**
 * Parse a Coinbase /candles response: [[time, low, high, open, close, volume], ...]
 * (newest first) into ascending HistoryQuotes with bid=ask=close.
 * Malformed rows are dropped; the result is sorted ascending by ts.
 */
export function parseCandles(raw: unknown): HistoryQuote[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryQuote[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [time, , , , close] = row as unknown[];
    if (
      typeof time !== 'number' ||
      !Number.isFinite(time) ||
      time <= 0 ||
      typeof close !== 'number' ||
      !Number.isFinite(close) ||
      close <= 0
    ) {
      continue;
    }
    out.push({ ts: Math.round(time * 1000), bid: close, ask: close });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Split [end - months, end] into windows of at most COINBASE_MAX_CANDLES
 * hourly candles each, ordered oldest-first. Windows are half-open
 * [start, end); the final window ends exactly at endMs.
 */
export function backfillWindows(
  endMs: number,
  months: number,
): Array<{ start: number; end: number }> {
  const totalMs = Math.round(months * 30.4375 * 86_400_000);
  const startMs = endMs - totalMs;
  const windowMs = COINBASE_MAX_CANDLES * BACKFILL_GRANULARITY_SECONDS * 1000;
  const windows: Array<{ start: number; end: number }> = [];
  let wEnd = endMs;
  while (wEnd > startMs) {
    const wStart = Math.max(startMs, wEnd - windowMs);
    windows.push({ start: wStart, end: wEnd });
    wEnd = wStart;
  }
  return windows.reverse();
}

/**
 * Nearest bid/ask at-or-before each timestamp, one pair per query.
 * Uses a VALUES CTE + correlated index seeks (validated against D1).
 * Timestamps ride as validated integer literals, not bound parameters —
 * D1 caps bound parameters at 100/query and a long timeline would exceed it.
 * Both history eras are read: the backfill ends where live quotes begin,
 * so the timeline is continuous.
 */
export async function quotesForTimeline(
  env: Env,
  pair: string,
  timeline: number[],
): Promise<HistoryQuote[]> {
  if (timeline.length === 0) return [];
  const values = timeline
    .filter((t) => Number.isFinite(t) && t > 0)
    .map((t) => `(${Math.round(t)})`)
    .join(',');
  if (values.length === 0) return [];
  const rows = await q<{ need_ts: number; bid: number | null; ask: number | null }>(
    env.DB,
    `WITH needs(ts) AS (VALUES ${values})
     SELECT needs.ts AS need_ts,
       (SELECT bid FROM quotes WHERE pair = ? AND ts <= needs.ts ORDER BY ts DESC LIMIT 1) AS bid,
       (SELECT ask FROM quotes WHERE pair = ? AND ts <= needs.ts ORDER BY ts DESC LIMIT 1) AS ask
     FROM needs`,
    pair,
    pair,
  );
  return rows
    .filter((r) => r.bid !== null && r.ask !== null)
    .map((r) => ({ ts: r.need_ts, bid: r.bid as number, ask: r.ask as number }));
}

/** Earliest live (1-minute) quote for a pair — the backfill's end boundary. */
export async function liveHistoryStart(
  env: Env,
  pair: string,
): Promise<number | null> {
  const rows = await q<{ ts: number | null }>(
    env.DB,
    'SELECT MIN(ts) AS ts FROM quotes WHERE pair = ? AND source = ?',
    pair,
    LIVE_SOURCE,
  );
  const ts = rows[0]?.ts ?? null;
  return typeof ts === 'number' && ts > 0 ? ts : null;
}

/**
 * Evenly spaced timestamps over [fromTs, toTs], at most maxPoints, always
 * including both endpoints. Pure — unit tested. Used to build the market
 * backdrop series for the simulator replay chart.
 */
export function evenTimestamps(
  fromTs: number,
  toTs: number,
  maxPoints: number,
): number[] {
  if (
    !Number.isFinite(fromTs) ||
    !Number.isFinite(toTs) ||
    !(toTs > fromTs) ||
    !Number.isFinite(maxPoints) ||
    maxPoints < 1
  ) {
    return [];
  }
  const n = Math.max(2, Math.min(10_000, Math.floor(maxPoints)));
  const out: number[] = [];
  const step = (toTs - fromTs) / (n - 1);
  for (let i = 0; i < n; i++) {
    out.push(Math.round(fromTs + i * step));
  }
  return [...new Set(out)];
}

/**
 * Mid-price market series over [fromTs, toTs] for charting, downsampled
 * server-side to at most maxPoints. Built on quotesForTimeline (nearest quote
 * at-or-before each target), so every point is no-lookahead by construction.
 * Reads quotes only — writes nothing.
 */
export async function marketSeries(
  env: Env,
  pair: string,
  fromTs: number,
  toTs: number,
  maxPoints: number = MAX_MARKET_POINTS,
): Promise<MarketPoint[]> {
  const targets = evenTimestamps(fromTs, toTs, maxPoints);
  if (targets.length === 0) return [];
  const quotes = await quotesForTimeline(env, pair, targets);
  return quotes.map((qq) => ({ t: qq.ts, price: (qq.bid + qq.ask) / 2 }));
}
