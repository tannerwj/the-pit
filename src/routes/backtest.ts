// The Pit — backtest endpoint.
// POST /api/v1/backtest (agent auth).
//
// Replays hypothetical market trades against historical bid/ask with the live
// fill model (touch-side quote + 5bps slippage; no lookahead; 3x leverage cap
// per trade like live). Pure and stateless: nothing is written to D1 — no
// orders, positions, or entries are created. Paper only.

import type { Env } from '../lib/types';
import { requireAgent, json, err } from '../lib/auth';
import {
  runBacktestReplay,
  backtestStats,
  backtestSummary,
  type BacktestTradeInput,
} from '../lib/backtest';
import { downsamplePoints } from '../lib/whatif';
import { quotesForTimeline, normalizeDbPair } from '../lib/history';

const MAX_TRADES = 500;
const MAX_POINTS = 120;

interface RawTrade {
  pair?: unknown;
  side?: unknown;
  qty?: unknown;
  notional?: unknown;
  timestamp?: unknown;
}

function parseTrade(
  raw: unknown,
  index: number,
  now: number,
): { trade: BacktestTradeInput } | { error: string } {
  const fail = (m: string) => ({ error: `trades[${index}]: ${m}` });
  if (typeof raw !== 'object' || raw === null) return fail('must be an object');
  const t = raw as RawTrade;

  const pair = normalizeDbPair(t.pair);
  if (!pair) return fail('pair must be one of BTC/USD, ETH/USD, SOL/USD, XRP/USD, DOGE/USD ("/" or "-" form)');

  if (t.side !== 'long' && t.side !== 'short') {
    return fail('side must be "long" or "short"');
  }

  const qtyRaw = t.qty;
  const notionalRaw = t.notional;
  const hasQty = qtyRaw !== undefined && qtyRaw !== null;
  const hasNotional = notionalRaw !== undefined && notionalRaw !== null;
  if (hasQty === hasNotional) {
    return fail('exactly one of qty (base units) or notional (USD) is required');
  }
  let qty: number | null = null;
  let notional: number | null = null;
  if (hasQty) {
    if (typeof qtyRaw !== 'number' || !Number.isFinite(qtyRaw) || qtyRaw <= 0) {
      return fail('qty must be a positive number of base units');
    }
    qty = qtyRaw;
  } else {
    if (typeof notionalRaw !== 'number' || !Number.isFinite(notionalRaw) || notionalRaw <= 0) {
      return fail('notional must be a positive USD amount');
    }
    notional = notionalRaw;
  }

  const ts = t.timestamp;
  if (typeof ts !== 'number' || !Number.isInteger(ts) || ts <= 0) {
    return fail('timestamp must be a positive integer unix-ms timestamp');
  }
  if (ts > now) return fail('timestamp is in the future');

  return { trade: { pair, side: t.side, qty, notional, ts } };
}

export async function postBacktest(
  req: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err('bad_request', 'Invalid JSON body', 400);
  }
  if (typeof body !== 'object' || body === null) {
    return err('bad_request', 'Request body must be a JSON object', 400);
  }

  const capRaw = body['starting_capital'];
  const startingCapital = capRaw === undefined ? 10_000 : capRaw;
  if (
    typeof startingCapital !== 'number' ||
    !Number.isFinite(startingCapital) ||
    startingCapital < 1000 ||
    startingCapital > 100000
  ) {
    return err('bad_request', 'starting_capital must be between 1000 and 100000', 422);
  }

  const tradesRaw = body['trades'];
  if (!Array.isArray(tradesRaw)) {
    return err('bad_request', 'trades must be an array', 422);
  }
  if (tradesRaw.length > MAX_TRADES) {
    return err('bad_request', `trades is capped at ${MAX_TRADES} per request`, 422);
  }

  const now = Date.now();
  const trades: BacktestTradeInput[] = [];
  for (let i = 0; i < tradesRaw.length; i++) {
    const parsed = parseTrade(tradesRaw[i], i, now);
    if ('error' in parsed) return err('bad_request', parsed.error, 422);
    trades.push(parsed.trade);
  }

  // Timeline: a pre-first-trade anchor (so the curve starts at starting
  // capital) plus every trade timestamp. Downsampled later for the response.
  const tradeTs = [...new Set(trades.map((t) => t.ts))].sort((a, b) => a - b);
  const timeline =
    tradeTs.length === 0 ? [now] : [tradeTs[0] - 1, ...tradeTs];

  const pairs = [...new Set(trades.map((t) => t.pair))];
  const quotesByPair = new Map();
  for (const pair of pairs) {
    quotesByPair.set(pair, await quotesForTimeline(env, pair, timeline));
  }

  const replay = runBacktestReplay({
    trades,
    quotesByPair,
    timeline,
    startingCapital,
  });
  const stats = backtestStats(replay.points, startingCapital);

  return json({
    starting_capital: startingCapital,
    trades_submitted: trades.length,
    trades_filled: replay.filled,
    trades_rejected: replay.rejected,
    return_pct: stats.return_pct,
    max_dd: stats.max_dd,
    sharpe: stats.sharpe,
    points: downsamplePoints(replay.points, MAX_POINTS),
    timeline_points: timeline.length,
    trades: replay.trades,
    summary: backtestSummary({
      startingCapital,
      finalEquity: replay.finalEquity,
      returnPct: stats.return_pct,
      maxDd: stats.max_dd,
      sharpe: stats.sharpe,
      filled: replay.filled,
      rejected: replay.rejected,
      pairs,
      fromTs: tradeTs.length > 0 ? tradeTs[0] : null,
      toTs: tradeTs.length > 0 ? tradeTs[tradeTs.length - 1] : null,
    }),
    honesty: {
      fill_model:
        'market fills at the historical touch-side quote + 5bps slippage — the same model as live trading',
      lookahead:
        'none — every fill uses the nearest quote at-or-before its timestamp',
      leverage:
        '3x max enforced per trade, like live; breaching trades are skipped and reported',
      liquidation: 'not simulated',
      history:
        '1-minute live bid/ask from 2026-09-20; hourly backfilled Coinbase candles before that (bid=ask=close — public candles carry no spread)',
      writes: 'none — backtests never create orders, positions, or entries',
    },
  });
}
