// The Pit — backtest engine (pure hypothetical-trade replay, no I/O).
//
// Replays an agent-submitted list of hypothetical market trades against
// historical bid/ask with the SAME fill model as live trading
// (marketFillPrice + applyFill from engine.ts — never forked):
//   - fill at the touch-side quote + 5bps adverse slippage
//   - no lookahead: nearest quote at-or-before each trade timestamp
//   - 3x max leverage enforced per trade, like live (breaching trades are
//     skipped and reported, mirroring a live 422 rejection)
//   - liquidation is NOT simulated (same documented choice as what-if)

import {
  quoteAt,
  type WhatIfQuote,
} from './whatif';
import {
  applyFill,
  marketFillPrice,
  checkLeverage,
  midPrice,
  MAX_LEVERAGE,
} from './engine';
import { computeAlphaScore, type EquityPoint } from './scoring';

export type BacktestSide = 'long' | 'short';

export interface BacktestTradeInput {
  pair: string; // DB form, e.g. 'BTC/USD'
  side: BacktestSide;
  /** Base units; exactly one of qty / notional is set (validated by the route). */
  qty: number | null;
  /** USD notional; converted to qty at the fill price. */
  notional: number | null;
  ts: number; // hypothetical fill time, unix ms
}

export interface BacktestTradeResult {
  index: number;
  pair: string;
  side: BacktestSide;
  qty: number;
  notional_usd: number;
  ts: number;
  status: 'filled' | 'rejected';
  fill_price: number | null;
  reject_reason: 'no_history' | 'leverage' | null;
  /** Cumulative realized PnL after this trade. */
  realized_pnl: number;
  equity_after: number;
}

export interface BacktestArgs {
  trades: BacktestTradeInput[];
  /** Per pair, quotes sorted ascending by ts. */
  quotesByPair: Map<string, WhatIfQuote[]>;
  /** Sorted unique timestamps to evaluate equity at. */
  timeline: number[];
  startingCapital: number;
}

export interface BacktestResult {
  points: EquityPoint[];
  finalEquity: number;
  realizedPnl: number;
  trades: BacktestTradeResult[];
  filled: number;
  rejected: number;
}

const toEngineSide = (s: BacktestSide): 'buy' | 'sell' =>
  s === 'long' ? 'buy' : 'sell';

/** Replay hypothetical market trades. Pure function. */
export function runBacktestReplay(args: BacktestArgs): BacktestResult {
  const indexed = args.trades.map((t, i) => ({ ...t, index: i }));
  indexed.sort((a, b) => a.ts - b.ts || a.index - b.index);
  const timeline = [...args.timeline].sort((a, b) => a - b);

  let cash = args.startingCapital;
  const positions = new Map<string, { qty: number; avgPrice: number }>();
  let realizedPnl = 0;
  let filled = 0;
  let rejected = 0;
  const tradeResults: BacktestTradeResult[] = [];
  const points: EquityPoint[] = [];

  const markAt = (pair: string, t: number, avgPrice: number): number => {
    const qq = quoteAt(args.quotesByPair.get(pair), t);
    return qq ? midPrice(qq) : avgPrice;
  };
  const equityNow = (t: number): number => {
    let e = cash;
    for (const [pair, pos] of positions) {
      if (pos.qty !== 0) e += pos.qty * markAt(pair, t, pos.avgPrice);
    }
    return e;
  };

  let ti = 0;
  for (const t of timeline) {
    while (ti < indexed.length && indexed[ti].ts <= t) {
      const tr = indexed[ti];
      ti += 1;
      const engineSide = toEngineSide(tr.side);
      const qq = quoteAt(args.quotesByPair.get(tr.pair), tr.ts);
      if (!qq) {
        rejected += 1;
        tradeResults.push({
          index: tr.index,
          pair: tr.pair,
          side: tr.side,
          qty: tr.qty ?? 0,
          notional_usd: tr.notional ?? 0,
          ts: tr.ts,
          status: 'rejected',
          fill_price: null,
          reject_reason: 'no_history',
          realized_pnl: realizedPnl,
          equity_after: equityNow(t),
        });
        continue;
      }
      const fillPrice = marketFillPrice(qq, engineSide);
      const qty =
        tr.qty !== null && tr.qty !== undefined
          ? tr.qty
          : (tr.notional as number) / fillPrice;
      const pos = positions.get(tr.pair) ?? { qty: 0, avgPrice: 0 };
      const lev = checkLeverage({
        cash,
        posQty: pos.qty,
        side: engineSide,
        orderQty: qty,
        fillPrice,
        maxLeverage: MAX_LEVERAGE,
      });
      if (!lev.ok) {
        rejected += 1;
        tradeResults.push({
          index: tr.index,
          pair: tr.pair,
          side: tr.side,
          qty,
          notional_usd: qty * fillPrice,
          ts: tr.ts,
          status: 'rejected',
          fill_price: fillPrice,
          reject_reason: 'leverage',
          realized_pnl: realizedPnl,
          equity_after: equityNow(t),
        });
        continue;
      }
      const res = applyFill(pos, engineSide, qty, fillPrice);
      positions.set(tr.pair, { qty: res.qty, avgPrice: res.avgPrice });
      cash += res.cashDelta;
      realizedPnl += res.realizedPnl;
      filled += 1;
      tradeResults.push({
        index: tr.index,
        pair: tr.pair,
        side: tr.side,
        qty,
        notional_usd: qty * fillPrice,
        ts: tr.ts,
        status: 'filled',
        fill_price: fillPrice,
        reject_reason: null,
        realized_pnl: realizedPnl,
        equity_after: equityNow(tr.ts),
      });
    }
    points.push({ ts: t, equity: equityNow(t) });
  }

  // Report trades in the caller's original order.
  tradeResults.sort((a, b) => a.index - b.index);

  return {
    points,
    finalEquity: points.length > 0 ? points[points.length - 1].equity : cash,
    realizedPnl,
    trades: tradeResults,
    filled,
    rejected,
  };
}

export interface BacktestStats {
  return_pct: number;
  max_dd: number;
  sharpe: number;
}

export function backtestStats(
  points: EquityPoint[],
  startingCapital: number,
): BacktestStats {
  const c = computeAlphaScore(points, startingCapital);
  return {
    return_pct: c.totalReturn * 100,
    max_dd: c.maxDrawdown * 100,
    sharpe: c.sharpe,
  };
}

const money = (x: number): string =>
  '$' + Math.round(x).toLocaleString('en-US');
const pct1 = (x: number): string =>
  `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

/** One plain-English summary line for a backtest. */
export function backtestSummary(args: {
  startingCapital: number;
  finalEquity: number;
  returnPct: number;
  maxDd: number;
  sharpe: number;
  filled: number;
  rejected: number;
  pairs: string[];
  fromTs: number | null;
  toTs: number | null;
}): string {
  const month = (ts: number): string =>
    new Date(ts).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const span =
    args.fromTs !== null && args.toTs !== null
      ? ` from ${month(args.fromTs)} to ${month(args.toTs)}`
      : '';
  const pairs = args.pairs.length > 0 ? ` on ${args.pairs.join(', ')}` : '';
  const tradeWord = args.filled === 1 ? 'trade' : 'trades';
  let s =
    `${args.filled} hypothetical ${tradeWord}${pairs}${span} would have turned ` +
    `${money(args.startingCapital)} into ${money(args.finalEquity)} ` +
    `(${pct1(args.returnPct / 100)}, max drawdown ${pct1(args.maxDd / 100)}, Sharpe ${args.sharpe.toFixed(2)}).`;
  if (args.rejected > 0) {
    s += ` ${args.rejected} trade${args.rejected === 1 ? ' was' : 's were'} skipped (no history or 3x leverage cap).`;
  }
  return s;
}
