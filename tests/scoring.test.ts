// Unit tests for src/lib/scoring.ts (Alpha Score v1).
// The formula is implemented EXACTLY per CONTRACT.md; these tests pin the
// math, including the required property: a +200%/60%-DD curve MUST score
// strictly below a +30%/5%-DD curve. If that property fails, the formula
// itself stays fixed and the numbers are reported back — never retuned here.
import { describe, expect, it } from 'vitest';
import { computeAlphaScore, type EquityPoint } from '../src/lib/scoring';

const DAY_MS = 86_400_000;
const SNAP_MS = 5 * 60 * 1000; // five-minute snapshots
const SNAPS_PER_DAY = 288;

// Deterministic PRNG (mulberry32) so synthetic curves are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller standard normal from a uniform PRNG.
function makeGaussian(rng: () => number): () => number {
  return () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

interface Segment {
  points: number; // snapshot count
  from: number;
  to: number;
  vol: number; // per-5min lognormal noise std
}

/**
 * Geometric random-walk curve: each segment compounds geometrically from
 * `from` to `to` with lognormal noise. The noise is mean-adjusted per
 * segment so endpoints land exactly on `from`/`to` (segments chain
 * exactly), keeping the walk jagged but deterministic in level.
 * Always positive by construction.
 */
function buildCurve(seed: number, segments: Segment[], startTs: number): EquityPoint[] {
  const randn = makeGaussian(mulberry32(seed));
  const points: EquityPoint[] = [];
  let ts = startTs;
  for (const seg of segments) {
    // Raw log-returns, then shift them so the segment compounds exactly from->to.
    const raws: number[] = [];
    let sum = 0;
    for (let i = 0; i < seg.points; i++) {
      const r = seg.vol * randn();
      raws.push(r);
      sum += r;
    }
    const adjust = (Math.log(seg.to / seg.from) - sum) / seg.points;
    let equity = seg.from;
    if (points.length === 0) points.push({ ts, equity }); // segment starts chain exactly
    for (let i = 0; i < seg.points; i++) {
      equity = equity * Math.exp(raws[i] + adjust);
      ts += SNAP_MS;
      points.push({ ts, equity });
    }
  }
  return points;
}

const SEASON_START = Date.UTC(2026, 0, 1); // midnight UTC, day-aligned
const STARTING = 10000;

describe('flat curve', () => {
  it('scores the neutral case: all components at their neutral values', () => {
    const points: EquityPoint[] = [];
    for (let i = 0; i < 14 * SNAPS_PER_DAY; i++) {
      points.push({ ts: SEASON_START + i * SNAP_MS, equity: STARTING });
    }
    const s = computeAlphaScore(points, STARTING);
    expect(s.totalReturn).toBe(0);
    expect(s.sharpe).toBe(0);
    expect(s.maxDrawdown).toBe(0);
    expect(s.winRate).toBe(1);
    expect(s.profitFactor).toBe(1);
    // R_c=1/3, S_c=1/3, DD_c=1, risk=0.35/3+0.65, C_c=0.75
    // -> 100*(0.4/3 + 0.4*(0.35/3+0.65) + 0.2*0.75) = 59
    expect(s.alphaScore).toBe(59);
  });
});

describe('single-day / degenerate curves', () => {
  it('fewer than 2 valid days => winRate=1, profitFactor=1', () => {
    const points: EquityPoint[] = [];
    for (let i = 0; i < 10; i++) {
      points.push({ ts: SEASON_START + i * SNAP_MS, equity: STARTING + i * 10 });
    }
    const s = computeAlphaScore(points, STARTING);
    expect(s.winRate).toBe(1);
    expect(s.profitFactor).toBe(1);
    expect(s.totalReturn).toBeCloseTo(90 / STARTING, 10);
  });

  it('a single snapshot degenerates gracefully', () => {
    const s = computeAlphaScore([{ ts: SEASON_START, equity: STARTING }], STARTING);
    expect(s.winRate).toBe(1);
    expect(s.profitFactor).toBe(1);
    expect(s.sharpe).toBe(0);
    expect(s.maxDrawdown).toBe(0);
  });

  it('is order-independent (snapshots sorted internally)', () => {
    const points: EquityPoint[] = [];
    for (let i = 0; i < 2 * SNAPS_PER_DAY; i++) {
      points.push({ ts: SEASON_START + i * SNAP_MS, equity: STARTING + i });
    }
    const a = computeAlphaScore(points, STARTING);
    const b = computeAlphaScore([...points].reverse(), STARTING);
    expect(b).toEqual(a);
  });
});

describe('day-return grouping', () => {
  it('uses UTC day boundaries', () => {
    // Equity doubles within day 1, flat on day 2.
    const points: EquityPoint[] = [
      { ts: SEASON_START, equity: 100 },
      { ts: SEASON_START + 12 * 3600 * 1000, equity: 200 },
      { ts: SEASON_START + DAY_MS, equity: 200 },
      { ts: SEASON_START + DAY_MS + 12 * 3600 * 1000, equity: 200 },
    ];
    const s = computeAlphaScore(points, 100);
    expect(s.winRate).toBe(1); // both days >= 0
    expect(s.totalReturn).toBe(1); // (200-100)/100
    // Day 1 return = +100% (profit), day 2 = 0 (neither profit nor loss):
    // grossProfit > 0, grossLoss = 0 => profitFactor = 3.
    expect(s.profitFactor).toBe(3);
  });

  it('profitFactor divides gross profit by gross loss', () => {
    // Day 1: 100 -> 150 (+50%). Day 2: 150 -> 100 (-33.3%).
    const points: EquityPoint[] = [
      { ts: SEASON_START, equity: 100 },
      { ts: SEASON_START + 12 * 3600 * 1000, equity: 150 },
      { ts: SEASON_START + DAY_MS, equity: 150 },
      { ts: SEASON_START + DAY_MS + 12 * 3600 * 1000, equity: 100 },
    ];
    const s = computeAlphaScore(points, 100);
    expect(s.winRate).toBe(0.5);
    expect(s.profitFactor).toBeCloseTo(0.5 / (1 / 3), 10);
  });

  it('days with a single snapshot are skipped', () => {
    const points: EquityPoint[] = [
      { ts: SEASON_START, equity: 100 },
      { ts: SEASON_START + DAY_MS, equity: 200 },
      { ts: SEASON_START + DAY_MS + 12 * 3600 * 1000, equity: 200 },
    ];
    const s = computeAlphaScore(points, 100);
    // Only day 2 is valid => < 2 valid days => defaults.
    expect(s.winRate).toBe(1);
    expect(s.profitFactor).toBe(1);
  });
});

describe('maxDrawdown', () => {
  it('measures peak-to-trough as a 0..1 fraction', () => {
    const points: EquityPoint[] = [
      { ts: SEASON_START, equity: 100 },
      { ts: SEASON_START + SNAP_MS, equity: 200 },
      { ts: SEASON_START + 2 * SNAP_MS, equity: 120 }, // 40% DD from 200
      { ts: SEASON_START + 3 * SNAP_MS, equity: 160 },
    ];
    const s = computeAlphaScore(points, 100);
    expect(s.maxDrawdown).toBeCloseTo(0.4, 10);
  });

  it('is 0 when equity never drops', () => {
    const points: EquityPoint[] = [
      { ts: SEASON_START, equity: 100 },
      { ts: SEASON_START + SNAP_MS, equity: 100 },
      { ts: SEASON_START + 2 * SNAP_MS, equity: 150 },
    ];
    expect(computeAlphaScore(points, 100).maxDrawdown).toBe(0);
  });
});

describe('Alpha Score v1 property (REQUIRED)', () => {
  // Curve A: jagged, ends ~+200% with ~60% max drawdown.
  // Rally 10k -> 28k (4 days), crash to 11.2k (3 days, -60%), climb to 30k (7 days).
  const curveA = buildCurve(
    42,
    [
      { points: 4 * SNAPS_PER_DAY, from: STARTING, to: 28000, vol: 0.012 },
      { points: 3 * SNAPS_PER_DAY, from: 28000, to: 11200, vol: 0.012 },
      { points: 7 * SNAPS_PER_DAY, from: 11200, to: 30000, vol: 0.012 },
    ],
    SEASON_START,
  );

  // Curve B: smooth, ends ~+30% with <5% max drawdown.
  const curveB = buildCurve(
    7,
    [{ points: 14 * SNAPS_PER_DAY, from: STARTING, to: 13000, vol: 0.0004 }],
    SEASON_START,
  );

  const a = computeAlphaScore(curveA, STARTING);
  const b = computeAlphaScore(curveB, STARTING);

  it('curve A really is the jagged +200% / 60%-DD case', () => {
    expect(a.totalReturn).toBeGreaterThan(1.8);
    expect(a.totalReturn).toBeLessThan(2.2);
    expect(a.maxDrawdown).toBeGreaterThan(0.5);
    expect(a.maxDrawdown).toBeLessThan(0.7);
    // eslint-disable-next-line no-console
    console.log('A components:', JSON.stringify(a));
  });

  it('curve B really is the smooth +30% / low-DD case', () => {
    expect(b.totalReturn).toBeGreaterThan(0.25);
    expect(b.totalReturn).toBeLessThan(0.35);
    expect(b.maxDrawdown).toBeLessThan(0.05);
    // eslint-disable-next-line no-console
    console.log('B components:', JSON.stringify(b));
  });

  it('smooth +30% scores STRICTLY above jagged +200% with 60% DD', () => {
    // eslint-disable-next-line no-console
    console.log(`alphaScore(A)=${a.alphaScore} alphaScore(B)=${b.alphaScore}`);
    expect(b.alphaScore).toBeGreaterThan(a.alphaScore);
  });
});
