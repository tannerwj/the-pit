// The Pit — admin history backfill.
// POST /api/v1/admin/history/backfill (X-Admin-Secret; applied by the router).
//
// Fills the pre-collection era with hourly Coinbase candles so backtests and
// the what-if engine see a continuous history. Idempotent: rows carry
// source='coinbase-backfill' and INSERT OR IGNORE + the UNIQUE(pair,ts,source)
// index make re-runs insert nothing new. One pair per call (each call does
// ~30 Coinbase fetches for 12 months); loop over pairs from the shell.

import type { Env } from '../lib/types';
import { json, err } from '../lib/auth';
import { SUPPORTED_PAIRS } from '../lib/leagues';
import {
  BACKFILL_SOURCE,
  normalizeDbPair,
  candlesUrl,
  parseCandles,
  backfillWindows,
  liveHistoryStart,
  type HistoryQuote,
} from '../lib/history';

const INSERT_CHUNK = 500;
const FETCH_TIMEOUT_MS = 20_000;

async function fetchCandles(
  pair: string,
  start: number,
  end: number,
): Promise<HistoryQuote[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(candlesUrl(pair, start, end), {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'the-pit/history-backfill' },
    });
    if (!res.ok) {
      throw new Error(`Coinbase candles HTTP ${res.status} for ${pair}`);
    }
    return parseCandles(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

async function insertQuotes(
  env: Env,
  pair: string,
  quotes: HistoryQuote[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < quotes.length; i += INSERT_CHUNK) {
    const chunk = quotes.slice(i, i + INSERT_CHUNK);
    const stmts = chunk.map((qq) =>
      env.DB.prepare(
        'INSERT OR IGNORE INTO quotes (pair, ts, bid, ask, source) VALUES (?, ?, ?, ?, ?)',
      ).bind(pair, qq.ts, qq.bid, qq.ask, BACKFILL_SOURCE),
    );
    const results = await env.DB.batch(stmts);
    for (const r of results) inserted += r.meta?.changes ?? 0;
  }
  return inserted;
}

export async function backfillHistory(
  req: Request,
  env: Env,
): Promise<Response> {
  // Params from the JSON body, falling back to the query string for curl.
  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return err('bad_request', 'Invalid JSON body', 400);
  }
  const params = new URL(req.url).searchParams;
  const pairRaw = body['pair'] ?? params.get('pair');
  const monthsRaw = body['months'] ?? params.get('months');
  const endRaw = body['end'] ?? params.get('end');

  const pair = normalizeDbPair(pairRaw);
  if (!pair) {
    return err(
      'bad_request',
      `pair is required; one of ${(SUPPORTED_PAIRS as readonly string[]).join(', ')}`,
      422,
    );
  }
  const months = monthsRaw === undefined || monthsRaw === null || monthsRaw === '' ? 12 : Number(monthsRaw);
  if (!Number.isInteger(months) || months < 1 || months > 24) {
    return err('bad_request', 'months must be an integer 1..24', 422);
  }
  let endTs: number | null = null;
  if (endRaw !== undefined && endRaw !== null && endRaw !== '') {
    endTs = Number(endRaw);
    if (!Number.isFinite(endTs) || endTs <= 0) {
      return err('bad_request', 'end must be a unix-ms timestamp', 422);
    }
  } else {
    endTs = (await liveHistoryStart(env, pair)) ?? Date.now();
  }

  const windows = backfillWindows(endTs, months);
  let candlesFetched = 0;
  let rowsInserted = 0;
  for (const w of windows) {
    let quotes: HistoryQuote[];
    try {
      quotes = await fetchCandles(pair, w.start, w.end);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err('coinbase_error', msg, 502);
    }
    candlesFetched += quotes.length;
    rowsInserted += await insertQuotes(env, pair, quotes);
  }

  return json({
    pair,
    months,
    range: { from: endTs - Math.round(months * 30.4375 * 86_400_000), to: endTs },
    windows: windows.length,
    candles_fetched: candlesFetched,
    rows_inserted: rowsInserted,
    source: BACKFILL_SOURCE,
    note: 'Idempotent: re-running inserts nothing new (UNIQUE index on pair, ts, source).',
  });
}
