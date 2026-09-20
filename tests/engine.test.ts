// Unit tests for src/lib/engine.ts (pure paper-engine math).
import { describe, expect, it } from 'vitest';
import {
  LIQUIDATION_FRACTION,
  MAX_LEVERAGE,
  SLIPPAGE_BPS,
  STARTING_CAPITAL,
  applyFill,
  checkLeverage,
  computeEquity,
  limitFillPrice,
  limitTouched,
  marketFillPrice,
  midPrice,
  shouldLiquidate,
} from '../src/lib/engine';

describe('constants', () => {
  it('matches the contract', () => {
    expect(SLIPPAGE_BPS).toBe(5);
    expect(MAX_LEVERAGE).toBe(3);
    expect(STARTING_CAPITAL).toBe(10000);
    expect(LIQUIDATION_FRACTION).toBe(0.2);
  });
});

describe('midPrice', () => {
  it('is (bid+ask)/2', () => {
    expect(midPrice({ bid: 60000, ask: 60100, ts: 0 })).toBe(60050);
  });
});

describe('marketFillPrice', () => {
  const q = { bid: 60000, ask: 60100, ts: 0 };

  it('buy fills at ask + 5bps', () => {
    // 60100 * 1.0005 = 60130.05
    expect(marketFillPrice(q, 'buy')).toBeCloseTo(60130.05, 6);
  });

  it('sell fills at bid - 5bps', () => {
    // 60000 * 0.9995 = 59970
    expect(marketFillPrice(q, 'sell')).toBeCloseTo(59970, 6);
  });

  it('buy is strictly worse than ask, sell strictly worse than bid', () => {
    expect(marketFillPrice(q, 'buy')).toBeGreaterThan(q.ask);
    expect(marketFillPrice(q, 'sell')).toBeLessThan(q.bid);
  });
});

describe('limitFillPrice / limitTouched', () => {
  it('limit fills at the limit price itself', () => {
    expect(limitFillPrice(59999.5)).toBe(59999.5);
  });

  it('buy-limit touches when best ask <= limit', () => {
    const q = { bid: 60000, ask: 60100, ts: 0 };
    expect(limitTouched(q, 'buy', 60100)).toBe(true);
    expect(limitTouched(q, 'buy', 60200)).toBe(true);
    expect(limitTouched(q, 'buy', 60099.99)).toBe(false);
  });

  it('sell-limit touches when best bid >= limit', () => {
    const q = { bid: 60000, ask: 60100, ts: 0 };
    expect(limitTouched(q, 'sell', 60000)).toBe(true);
    expect(limitTouched(q, 'sell', 59900)).toBe(true);
    expect(limitTouched(q, 'sell', 60000.01)).toBe(false);
  });
});

describe('applyFill', () => {
  it('opens a fresh long', () => {
    const r = applyFill({ qty: 0, avgPrice: 0 }, 'buy', 0.5, 60000);
    expect(r.qty).toBe(0.5);
    expect(r.avgPrice).toBe(60000);
    expect(r.realizedPnl).toBe(0);
    expect(r.cashDelta).toBe(-30000); // negative for buys
  });

  it('increases a long with a volume-weighted average', () => {
    const r = applyFill({ qty: 0.5, avgPrice: 60000 }, 'buy', 0.5, 62000);
    expect(r.qty).toBe(1);
    expect(r.avgPrice).toBeCloseTo(61000, 6);
    expect(r.realizedPnl).toBe(0);
    expect(r.cashDelta).toBe(-31000);
  });

  it('partially closes a long, realizing PnL on the closed part', () => {
    const r = applyFill({ qty: 1, avgPrice: 60000 }, 'sell', 0.4, 65000);
    expect(r.qty).toBeCloseTo(0.6, 10);
    expect(r.avgPrice).toBe(60000); // avg of the remainder is unchanged
    expect(r.realizedPnl).toBeCloseTo(0.4 * 5000, 6); // +2000
    expect(r.cashDelta).toBeCloseTo(0.4 * 65000, 6); // positive for sells
  });

  it('fully closes a long', () => {
    const r = applyFill({ qty: 1, avgPrice: 60000 }, 'sell', 1, 65000);
    expect(r.qty).toBe(0);
    expect(r.avgPrice).toBe(0);
    expect(r.realizedPnl).toBeCloseTo(5000, 6);
    expect(r.cashDelta).toBeCloseTo(65000, 6);
  });

  it('flips long to short through zero', () => {
    const r = applyFill({ qty: 1, avgPrice: 60000 }, 'sell', 1.5, 65000);
    expect(r.qty).toBeCloseTo(-0.5, 10);
    expect(r.avgPrice).toBe(65000); // flipped remainder opens at fill price
    expect(r.realizedPnl).toBeCloseTo(5000, 6); // closed long at +5000/BTC
    expect(r.cashDelta).toBeCloseTo(1.5 * 65000, 6);
  });

  it('increases a short with a volume-weighted average', () => {
    const r = applyFill({ qty: -0.5, avgPrice: 65000 }, 'sell', 0.5, 64000);
    expect(r.qty).toBe(-1);
    expect(r.avgPrice).toBeCloseTo(64500, 6);
    expect(r.realizedPnl).toBe(0);
    expect(r.cashDelta).toBeCloseTo(0.5 * 64000, 6);
  });

  it('covers a short partially, realizing PnL', () => {
    const r = applyFill({ qty: -1, avgPrice: 65000 }, 'buy', 0.4, 64000);
    expect(r.qty).toBeCloseTo(-0.6, 10);
    expect(r.avgPrice).toBe(65000);
    expect(r.realizedPnl).toBeCloseTo(0.4 * 1000, 6); // short wins as price falls
    expect(r.cashDelta).toBeCloseTo(-0.4 * 64000, 6);
  });

  it('flips short to long through zero', () => {
    const r = applyFill({ qty: -0.5, avgPrice: 65000 }, 'buy', 1.5, 60000);
    expect(r.qty).toBeCloseTo(1, 10);
    expect(r.avgPrice).toBe(60000);
    // covered the short: (65000 - 60000) * 0.5 = +2500
    expect(r.realizedPnl).toBeCloseTo(2500, 6);
    expect(r.cashDelta).toBeCloseTo(-1.5 * 60000, 6);
  });

  it('books a loss when closing a long below its average', () => {
    const r = applyFill({ qty: 1, avgPrice: 60000 }, 'sell', 1, 55000);
    expect(r.realizedPnl).toBeCloseTo(-5000, 6);
  });
});

describe('computeEquity', () => {
  it('is cash + qty*mid', () => {
    expect(computeEquity(8000, 0.5, 60000)).toBe(38000);
    expect(computeEquity(8000, -0.5, 60000)).toBe(-22000);
    expect(computeEquity(10000, 0, 60000)).toBe(10000);
  });
});

describe('checkLeverage', () => {
  it('rejects a trade that would exceed MAX_LEVERAGE', () => {
    // $10k cash, buy 1 BTC @ 60k -> $60k notional vs $10k equity = 6x
    const r = checkLeverage({ cash: 10000, posQty: 0, side: 'buy', orderQty: 1, fillPrice: 60000 });
    expect(r.ok).toBe(false);
    expect(r.notional).toBeCloseTo(60000, 6);
    expect(r.equity).toBeCloseTo(10000, 6);
    expect(r.leverage).toBeCloseTo(6, 6);
    expect(r.reason).toBeDefined();
  });

  it('allows a trade at exactly the cap', () => {
    // $10k cash, buy 0.5 BTC @ 60k -> $30k notional vs $10k equity = 3x
    const r = checkLeverage({ cash: 10000, posQty: 0, side: 'buy', orderQty: 0.5, fillPrice: 60000 });
    expect(r.ok).toBe(true);
    expect(r.leverage).toBeCloseTo(3, 6);
    expect(r.reason).toBeUndefined();
  });

  it('allows a small trade', () => {
    const r = checkLeverage({ cash: 10000, posQty: 0, side: 'buy', orderQty: 0.1, fillPrice: 60000 });
    expect(r.ok).toBe(true);
    expect(r.leverage).toBeCloseTo(0.6, 6);
  });

  it('checks the post-trade position, including existing exposure', () => {
    // Already long 0.4 @ 60k bought from $10k starting: cash = 10000 - 24000.
    // Adding 0.2 more -> $36k notional vs $10k equity = 3.6x -> rejected.
    const r = checkLeverage({ cash: -14000, posQty: 0.4, side: 'buy', orderQty: 0.2, fillPrice: 60000 });
    expect(r.ok).toBe(false);
    expect(r.leverage).toBeCloseTo(3.6, 6);
  });

  it('a reducing trade can bring leverage back under the cap', () => {
    // Same entry as above (cash -14000, long 0.4); selling 0.3 halves exposure.
    const r = checkLeverage({ cash: -14000, posQty: 0.4, side: 'sell', orderQty: 0.3, fillPrice: 60000 });
    expect(r.ok).toBe(true);
    expect(r.notional).toBeCloseTo(6000, 6);
  });
});

describe('shouldLiquidate', () => {
  it('liquidates at or below 20% of starting capital', () => {
    expect(shouldLiquidate(2000, 10000)).toBe(true);
    expect(shouldLiquidate(1999.99, 10000)).toBe(true);
    expect(shouldLiquidate(0, 10000)).toBe(true);
    expect(shouldLiquidate(2000.01, 10000)).toBe(false);
    expect(shouldLiquidate(10000, 10000)).toBe(false);
  });
});
