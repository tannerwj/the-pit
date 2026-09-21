// The Pit — what-if engine v1 (pure counterfactual replay, no I/O).
//
// Replays an entry's filled orders against historical bid/ask quotes with the
// same fill model as the live engine (market: touch side + 5bps slippage;
// limit: fills at the limit price). Honesty rules:
//   - no lookahead: every decision uses only data available at that timestamp
//     (nearest quote at-or-before t; running peak for stop-loss)
//   - fills replay at historical prices, never at future prices
//   - leverage caps are NOT enforced in replay (counterfactuals, not tradable)

import type { Side } from './types';
import { applyFill, marketFillPrice, midPrice } from './engine';
import {
  computeAlphaScore,
  type EquityPoint,
  type ScoreComponents,
} from './scoring';

export interface WhatIfFill {
  id: string;
  pair: string;
  side: Side;
  qty: number;
  type: 'market' | 'limit';
  limitPrice: number | null;
  ts: number; // filled_at, unix ms
}

export interface WhatIfQuote {
  ts: number;
  bid: number;
  ask: number;
}

export interface ReplayArgs {
  fills: WhatIfFill[];
  /** Per pair, quotes sorted ascending by ts. */
  quotesByPair: Map<string, WhatIfQuote[]>;
  /** Sorted unique timestamps to evaluate equity at (fill ts + snapshot ts). */
  timeline: number[];
  startingCapital: number;
  /** Sizing multiplier k applied to every fill. */
  sizing: number;
  /** Flatten-all when drawdown from the running peak hits this fraction (e.g. 0.10). Null = no stop. */
  stopLossPct: number | null;
  /** Replay as if this fill never happened (skip-worst-trade scenario). */
  skipFillId: string | null;
}

export interface ReplayResult {
  points: EquityPoint[];
  finalEquity: number;
  realizedPnl: number;
  fillsReplayed: number;
  fillsSkippedNoQuote: number;
  stopsTriggered: number;
}

/** Nearest quote at-or-before t (no lookahead). Binary search; null when none. */
export function quoteAt(
  quotes: WhatIfQuote[] | undefined,
  t: number,
): WhatIfQuote | null {
  if (!quotes || quotes.length === 0) return null;
  let lo = 0;
  let hi = quotes.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (quotes[m].ts <= t) {
      ans = m;
      lo = m + 1;
    } else {
      hi = m - 1;
    }
  }
  return ans === -1 ? null : quotes[ans];
}

/** Replay the fill log under a counterfactual scenario. Pure function. */
export function replayCounterfactual(args: ReplayArgs): ReplayResult {
  const fills = [...args.fills].sort((a, b) => a.ts - b.ts);
  const timeline = [...args.timeline].sort((a, b) => a - b);

  let cash = args.startingCapital;
  const positions = new Map<string, { qty: number; avgPrice: number }>();
  let peak = args.startingCapital;
  let stopsTriggered = 0;
  let fillsReplayed = 0;
  let fillsSkippedNoQuote = 0;
  let realizedPnl = 0;
  const points: EquityPoint[] = [];

  const markAt = (pair: string, t: number, avgPrice: number): number => {
    const q = quoteAt(args.quotesByPair.get(pair), t);
    return q ? midPrice(q) : avgPrice;
  };

  let fi = 0;
  for (const t of timeline) {
    // Apply every fill at-or-before t (each fill applied exactly once).
    while (fi < fills.length && fills[fi].ts <= t) {
      const f = fills[fi];
      fi += 1;
      if (args.skipFillId !== null && f.id === args.skipFillId) continue;
      const qty = f.qty * args.sizing;
      if (!(qty > 0)) continue;
      let fillPrice: number;
      if (f.type === 'limit' && f.limitPrice !== null && f.limitPrice > 0) {
        fillPrice = f.limitPrice;
      } else {
        const q = quoteAt(args.quotesByPair.get(f.pair), f.ts);
        if (!q) {
          fillsSkippedNoQuote += 1;
          continue;
        }
        fillPrice = marketFillPrice(q, f.side);
      }
      const pos = positions.get(f.pair) ?? { qty: 0, avgPrice: 0 };
      const res = applyFill(pos, f.side, qty, fillPrice);
      positions.set(f.pair, { qty: res.qty, avgPrice: res.avgPrice });
      cash += res.cashDelta;
      realizedPnl += res.realizedPnl;
      fillsReplayed += 1;
    }

    let equity = cash;
    for (const [pair, pos] of positions) {
      if (pos.qty !== 0) equity += pos.qty * markAt(pair, t, pos.avgPrice);
    }

    // Honored stop-loss: flatten everything at market when the drawdown
    // from the running peak reaches the threshold, then reset the peak.
    if (equity > peak) {
      peak = equity;
    } else if (
      args.stopLossPct !== null &&
      peak > 0 &&
      (peak - equity) / peak >= args.stopLossPct
    ) {
      for (const [pair, pos] of positions) {
        if (pos.qty === 0) continue;
        const closeSide: Side = pos.qty > 0 ? 'sell' : 'buy';
        const q = quoteAt(args.quotesByPair.get(pair), t);
        const closePrice = q ? marketFillPrice(q, closeSide) : pos.avgPrice;
        const res = applyFill(pos, closeSide, Math.abs(pos.qty), closePrice);
        cash += res.cashDelta;
        realizedPnl += res.realizedPnl;
        positions.set(pair, { qty: 0, avgPrice: 0 });
      }
      equity = cash; // everything flat
      peak = equity;
      stopsTriggered += 1;
    }

    points.push({ ts: t, equity });
  }

  return {
    points,
    finalEquity: points.length > 0 ? points[points.length - 1].equity : cash,
    realizedPnl,
    fillsReplayed,
    fillsSkippedNoQuote,
    stopsTriggered,
  };
}

// ---------------------------------------------------------------------------
// Scenarios + summary
// ---------------------------------------------------------------------------

export interface ScenarioResult {
  name: string;
  kind: 'sizing' | 'stop_loss' | 'skip_worst';
  params: Record<string, number | string>;
  return_pct: number;
  max_dd: number;
  sharpe: number;
  /** Scenario return minus actual return, in percentage points. */
  delta_return_pp: number;
  points: Array<{ t: number; equity: number }>;
  stops_triggered?: number;
  note?: string;
}

export interface ActualResult {
  return_pct: number;
  max_dd: number;
  sharpe: number;
  points: Array<{ t: number; equity: number }>;
}

function components(points: EquityPoint[], startingCapital: number): ScoreComponents {
  return computeAlphaScore(points, startingCapital);
}

/** Downsample to at most n points, always keeping first and last. */
export function downsamplePoints(
  points: EquityPoint[],
  n: number,
): Array<{ t: number; equity: number }> {
  if (points.length <= n) return points.map((p) => ({ t: p.ts, equity: p.equity }));
  const out: Array<{ t: number; equity: number }> = [];
  const step = (points.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    const p = points[Math.round(i * step)];
    out.push({ t: p.ts, equity: p.equity });
  }
  return out;
}

const pct = (x: number): string =>
  `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
// Drawdown is a magnitude (0..1), never signed: "max drawdown 8.1%", not "+8.1%".
const pctMag = (x: number): string => `${(Math.abs(x) * 100).toFixed(1)}%`;

export interface WhatIfInput {
  fills: WhatIfFill[];
  quotesByPair: Map<string, WhatIfQuote[]>;
  timeline: number[];
  startingCapital: number;
  actualPoints: EquityPoint[];
  sizings: number[];
  stopPcts: number[];
  includeSkipWorst: boolean;
  maxPoints: number;
}

/** Skip-worst-trade is O(n^2); cap it so the endpoint stays cheap. */
export const SKIP_WORST_MAX_FILLS = 200;

export function runWhatIf(input: WhatIfInput): {
  actual: ActualResult;
  scenarios: ScenarioResult[];
  summary: string;
} {
  const start = input.startingCapital;
  const actualC = components(input.actualPoints, start);
  const actual: ActualResult = {
    return_pct: actualC.totalReturn * 100,
    max_dd: actualC.maxDrawdown * 100,
    sharpe: actualC.sharpe,
    points: downsamplePoints(input.actualPoints, input.maxPoints),
  };

  const scenarios: ScenarioResult[] = [];
  const base = {
    fills: input.fills,
    quotesByPair: input.quotesByPair,
    timeline: input.timeline,
    startingCapital: start,
  };

  const toScenario = (
    name: string,
    kind: ScenarioResult['kind'],
    params: Record<string, number | string>,
    replay: ReplayResult,
    note?: string,
  ): ScenarioResult => {
    const c = components(replay.points, start);
    return {
      name,
      kind,
      params,
      return_pct: c.totalReturn * 100,
      max_dd: c.maxDrawdown * 100,
      sharpe: c.sharpe,
      delta_return_pp: c.totalReturn * 100 - actual.return_pct,
      points: downsamplePoints(replay.points, input.maxPoints),
      ...(replay.stopsTriggered > 0 ? { stops_triggered: replay.stopsTriggered } : {}),
      ...(note ? { note } : {}),
    };
  };

  for (const k of input.sizings) {
    const replay = replayCounterfactual({ ...base, sizing: k, stopLossPct: null, skipFillId: null });
    scenarios.push(
      toScenario(
        `${k}x sizing`,
        'sizing',
        { k },
        replay,
        replay.fillsSkippedNoQuote > 0
          ? `${replay.fillsSkippedNoQuote} fill(s) skipped: no historical quote at fill time`
          : undefined,
      ),
    );
  }

  for (const s of input.stopPcts) {
    const replay = replayCounterfactual({
      ...base,
      sizing: 1,
      stopLossPct: s,
      skipFillId: null,
    });
    scenarios.push(
      toScenario(`${Math.round(s * 100)}% stop-loss`, 'stop_loss', { stop_pct: Math.round(s * 100) }, replay),
    );
  }

  if (input.includeSkipWorst) {
    if (input.fills.length > SKIP_WORST_MAX_FILLS) {
      scenarios.push({
        name: 'skip worst trade',
        kind: 'skip_worst',
        params: {},
        return_pct: actual.return_pct,
        max_dd: actual.max_dd,
        sharpe: actual.sharpe,
        delta_return_pp: 0,
        points: [],
        note: `skipped: ${input.fills.length} fills exceeds the ${SKIP_WORST_MAX_FILLS}-fill cap for skip-worst replay`,
      });
    } else if (input.fills.length > 0) {
      let best: { fill: WhatIfFill; replay: ReplayResult } | null = null;
      for (const f of input.fills) {
        const replay = replayCounterfactual({
          ...base,
          sizing: 1,
          stopLossPct: null,
          skipFillId: f.id,
        });
        if (!best || replay.finalEquity > best.replay.finalEquity) {
          best = { fill: f, replay };
        }
      }
      if (best) {
        const d = new Date(best.fill.ts).toISOString().slice(0, 10);
        scenarios.push(
          toScenario(
            `skip worst trade (${best.fill.side} ${best.fill.qty} ${best.fill.pair} on ${d})`,
            'skip_worst',
            { skipped_order_id: best.fill.id },
            best.replay,
          ),
        );
      }
    }
  }

  // One plain-English summary line: the best counterfactual vs actual.
  let summary: string;
  const best = scenarios.reduce<ScenarioResult | null>(
    (acc, s) => (!acc || s.return_pct > acc.return_pct ? s : acc),
    null,
  );
  if (!best || best.delta_return_pp <= 0.05) {
    const closest = best ? ` — closest was ${best.name} at ${pct(best.return_pct / 100)}` : '';
    summary = `No counterfactual beat your actual ${pct(actual.return_pct / 100)} return${closest}.`;
  } else if (best.kind === 'sizing') {
    const k = best.params.k;
    summary =
      `Sizing every fill ${k}x would have turned ${pct(actual.return_pct / 100)} into ${pct(best.return_pct / 100)} ` +
      `(max drawdown ${pctMag(best.max_dd / 100)} vs ${pctMag(actual.max_dd / 100)} actual).`;
  } else if (best.kind === 'stop_loss') {
    summary =
      `Honoring a ${best.params.stop_pct}% stop-loss would have turned ${pct(actual.return_pct / 100)} into ${pct(best.return_pct / 100)} ` +
      `and cut max drawdown from ${pctMag(actual.max_dd / 100)} to ${pctMag(best.max_dd / 100)}.`;
  } else {
    const detail = best.name.startsWith('skip worst trade')
      ? best.name.slice('skip worst trade'.length)
      : '';
    summary =
      `Skipping your worst trade${detail} would have added +${best.delta_return_pp.toFixed(1)}pp of return ` +
      `(${pct(actual.return_pct / 100)} → ${pct(best.return_pct / 100)}).`;
  }

  return { actual, scenarios, summary };
}
