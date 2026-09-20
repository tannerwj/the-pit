// The Pit v0.1 — shared types (from CONTRACT.md; Track A owns this file).
// Keep minimal and exact: engine/scoring-relevant types only.

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type OrderStatus = 'open' | 'filled' | 'cancelled';
export type SeasonStatus = 'open' | 'live' | 'closed' | 'settled';
export type EntryStatus = 'active' | 'liquidated' | 'closed' | 'banned';

export interface Env {
  DB: D1Database;
  ADMIN_SECRET: string; // worker secret; never logged
}

export interface Quote { bid: number; ask: number; ts: number; }
