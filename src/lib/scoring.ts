// The Pit v0.1 — pure Alpha Score v1 math (no I/O).
// Implements the CONTRACT.md scoring.ts section exactly. Do NOT retune:
// the formula is published verbatim in docs/ALPHA_SCORE.md + llms.txt.

export interface EquityPoint {
  ts: number; // unix ms
  equity: number;
}

export interface ScoreComponents {
  totalReturn: number; // (last - start) / start
  sharpe: number; // annualized Sharpe from 5-min snapshot returns, rf=0
  maxDrawdown: number; // peak-to-trough, 0..1
  winRate: number; // fraction of UTC days with day-return >= 0
  profitFactor: number; // grossProfit / grossLoss over day-returns (>=0 handling below)
  alphaScore: number; // 0..100, rounded to 2 decimals
}

const MS_PER_DAY = 86_400_000;
const PERIODS_PER_YEAR = 365 * 24 * 12; // five-minute periods per year = 105120

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return r === 0 ? 0 : r; // normalize -0
}

export function computeAlphaScore(
  points: EquityPoint[],
  startingCapital: number,
): ScoreComponents {
  if (points.length === 0) {
    return {
      totalReturn: 0,
      sharpe: 0,
      maxDrawdown: 0,
      winRate: 1,
      profitFactor: 1,
      alphaScore: round2(100 * (0.4 * (1 / 3) + 0.4 * (0.35 / 3 + 0.65) + 0.2 * 0.75)),
    };
  }

  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const start = startingCapital;
  const lastEquity = sorted[sorted.length - 1].equity;
  const totalReturn = start > 0 ? lastEquity / start - 1 : 0;

  // Day returns: group snapshots by UTC day; day_return = last/first - 1.
  const byDay = new Map<number, EquityPoint[]>();
  for (const p of sorted) {
    const day = Math.floor(p.ts / MS_PER_DAY);
    const arr = byDay.get(day);
    if (arr) arr.push(p);
    else byDay.set(day, [p]);
  }
  const dayReturns: number[] = [];
  for (const arr of byDay.values()) {
    if (arr.length < 2) continue; // days with < 2 snapshots are skipped
    const first = arr[0].equity;
    const last = arr[arr.length - 1].equity;
    dayReturns.push(first > 0 ? last / first - 1 : 0);
  }

  let winRate: number;
  let profitFactor: number;
  if (dayReturns.length < 2) {
    winRate = 1;
    profitFactor = 1;
  } else {
    const wins = dayReturns.filter((r) => r >= 0).length;
    winRate = wins / dayReturns.length;
    const grossProfit = dayReturns.reduce((s, r) => s + Math.max(r, 0), 0);
    const grossLoss = dayReturns.reduce((s, r) => s + Math.max(-r, 0), 0);
    profitFactor =
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 3 : 1;
  }

  // Sharpe: per-snapshot simple returns, annualized from 5-minute periods, rf=0.
  let sharpe = 0;
  if (sorted.length >= 2) {
    const rets: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].equity;
      rets.push(prev > 0 ? sorted[i].equity / prev - 1 : 0);
    }
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    if (rets.length >= 2) {
      const variance =
        rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (rets.length - 1);
      const std = Math.sqrt(variance);
      const sharpe5min = std > 1e-12 ? mean / std : 0;
      sharpe = sharpe5min * Math.sqrt(PERIODS_PER_YEAR);
    }
  }

  // Max drawdown: max over the curve of (runningPeak - equity) / runningPeak.
  let maxDrawdown = 0;
  let peak = -Infinity;
  for (const p of sorted) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - p.equity) / peak);
  }

  // Normalization.
  const R_c = (clamp(totalReturn, -1, 2) + 1) / 3;
  const S_c = (clamp(sharpe, -2, 4) + 2) / 6;
  const DD_c = Math.pow(1 - clamp(maxDrawdown, 0, 1), 2.5);
  const risk = 0.35 * S_c + 0.65 * DD_c;
  const C_c = 0.5 * winRate + 0.5 * (profitFactor / (1 + profitFactor));
  const alphaScore = round2(100 * (0.4 * R_c + 0.4 * risk + 0.2 * C_c));

  return { totalReturn, sharpe, maxDrawdown, winRate, profitFactor, alphaScore };
}
