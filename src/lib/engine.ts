// The Pit v0.1 — pure paper-engine math (no I/O).
// Implements the CONTRACT.md engine.ts section exactly.

import type { Quote, Side } from './types';

export const SLIPPAGE_BPS = 5; // flat slippage on every fill
export const MAX_LEVERAGE = 3; // per-pair leverage cap
export const STARTING_CAPITAL = 10000; // virtual USD per season entry
export const LIQUIDATION_FRACTION = 0.2; // liquidate when equity <= 0.2 * starting

/** Mid price: (bid + ask) / 2. */
export function midPrice(q: Quote): number {
  return (q.bid + q.ask) / 2;
}

/**
 * Market fill price with slippage: buy at ask + 5bps, sell at bid - 5bps.
 * (Equivalent to mid + half-spread + 5bps slippage; see docs/API.md.)
 */
export function marketFillPrice(q: Quote, side: Side): number {
  return side === 'buy'
    ? q.ask * (1 + SLIPPAGE_BPS / 10000)
    : q.bid * (1 - SLIPPAGE_BPS / 10000);
}

/** Limit orders rest in the book; when touched they fill AT the limit price. */
export function limitFillPrice(limitPrice: number): number {
  return limitPrice;
}

/**
 * Touch rule: a buy-limit fills when bestAsk <= limitPrice;
 * a sell-limit fills when bestBid >= limitPrice.
 */
export function limitTouched(q: Quote, side: Side, limitPrice: number): boolean {
  return side === 'buy' ? q.ask <= limitPrice : q.bid >= limitPrice;
}

export interface PositionState {
  qty: number; // signed base units; +long / -short
  avgPrice: number;
}

export interface FillResult {
  qty: number;
  avgPrice: number;
  realizedPnl: number;
  cashDelta: number; // NEGATIVE for buys, positive for sells
}

/**
 * Apply a fill to a position. Handles position increase, full close, and
 * flip-through (crossing zero), realizing PnL on the closed portion.
 * Returns the new position, realized PnL, and cash delta.
 */
export function applyFill(
  pos: PositionState,
  side: Side,
  fillQty: number,
  fillPrice: number,
): FillResult {
  const signedFill = side === 'buy' ? fillQty : -fillQty;
  const existing = pos.qty;
  const cashDelta = side === 'buy' ? -fillQty * fillPrice : fillQty * fillPrice;

  if (existing === 0 || Math.sign(existing) === Math.sign(signedFill)) {
    // Opening or increasing: volume-weighted average of the new fill.
    const newQty = existing + signedFill;
    const avgPrice =
      newQty === 0
        ? 0
        : (Math.abs(existing) * pos.avgPrice + fillQty * fillPrice) / Math.abs(newQty);
    return { qty: newQty, avgPrice, realizedPnl: 0, cashDelta };
  }

  // Reducing, fully closing, or flipping through: realize PnL on the closed part.
  const closeQty = Math.min(fillQty, Math.abs(existing));
  const perUnit = existing > 0 ? fillPrice - pos.avgPrice : pos.avgPrice - fillPrice;
  const realizedPnl = closeQty * perUnit;
  const newQty = existing + signedFill;
  // Partial reduce keeps the old average; a full close has avg 0;
  // a flipped remainder opens fresh at the fill price.
  const avgPrice =
    newQty === 0
      ? 0
      : Math.sign(newQty) === Math.sign(existing)
        ? pos.avgPrice
        : fillPrice;
  return { qty: newQty, avgPrice, realizedPnl, cashDelta };
}

/** Mark-to-market equity: cash + qty * mid. */
export function computeEquity(cash: number, qty: number, mid: number): number {
  return cash + qty * mid;
}

export interface LeverageCheck {
  ok: boolean;
  notional: number;
  equity: number;
  leverage: number;
  reason?: string;
}

/**
 * Post-trade leverage check: would the position after this fill exceed the
 * season's max leverage? Equity is marked at the fill price.
 */
export function checkLeverage(args: {
  cash: number;
  posQty: number;
  side: Side;
  orderQty: number;
  fillPrice: number;
  maxLeverage?: number;
}): LeverageCheck {
  const maxLev = args.maxLeverage ?? MAX_LEVERAGE;
  const fill = applyFill({ qty: args.posQty, avgPrice: 0 }, args.side, args.orderQty, args.fillPrice);
  const notional = Math.abs(fill.qty) * args.fillPrice;
  const equity = args.cash + fill.cashDelta + fill.qty * args.fillPrice;
  const leverage = equity > 0 ? notional / equity : notional > 0 ? Infinity : 0;
  const ok = leverage <= maxLev;
  return {
    ok,
    notional,
    equity,
    leverage,
    reason: ok ? undefined : `leverage ${leverage.toFixed(2)}x exceeds max ${maxLev}x`,
  };
}

/** Liquidate when equity <= LIQUIDATION_FRACTION * starting capital. */
export function shouldLiquidate(equity: number, startingCapital: number): boolean {
  return equity <= LIQUIDATION_FRACTION * startingCapital;
}
