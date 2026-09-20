// The Pit v0.1 — cron handlers (quote ingest + equity snapshots).
// Track C. All money is virtual/paper. Never log secrets.

import type { Env, Quote, Side } from './lib/types';
import {
  applyFill,
  checkLeverage,
  computeEquity,
  limitFillPrice,
  limitTouched,
  marketFillPrice,
  midPrice,
  shouldLiquidate,
} from './lib/engine';
import { computeAlphaScore } from './lib/scoring';
import type { EquityPoint } from './lib/scoring';

const TICKER_URL = 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';
const PAIR = 'BTC/USD';

interface QuoteRow {
  bid: number;
  ask: number;
  ts: number;
}

interface LimitOrderRow {
  id: string;
  entry_id: string;
  pair: string;
  side: Side;
  qty: number;
  limit_price: number | null;
}

interface EntryRow {
  id: string;
  season_id: string;
  starting_capital: number;
  cash: number;
  pair: string;
}

interface PositionRow {
  qty: number;
  avg_price: number;
}

async function latestQuote(env: Env, pair: string): Promise<Quote | null> {
  const row = await env.DB.prepare(
    'SELECT bid, ask, ts FROM quotes WHERE pair = ? ORDER BY ts DESC LIMIT 1',
  )
    .bind(pair)
    .first<QuoteRow>();
  if (!row) return null;
  return { bid: row.bid, ask: row.ask, ts: row.ts };
}

async function upsertPosition(
  env: Env,
  entryId: string,
  pair: string,
  qty: number,
  avgPrice: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO positions (entry_id, pair, qty, avg_price, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (entry_id, pair)
     DO UPDATE SET qty = excluded.qty, avg_price = excluded.avg_price, updated_at = excluded.updated_at`,
  )
    .bind(entryId, pair, qty, avgPrice, Date.now())
    .run();
}

/**
 * 1-minute cron: ingest the Coinbase BTC-USD ticker, then match open limit
 * orders in live seasons against the fresh quote.
 */
export async function handleQuoteIngest(env: Env): Promise<void> {
  let quote: Quote;
  try {
    const res = await fetch(TICKER_URL);
    if (!res.ok) throw new Error(`coinbase ticker HTTP ${res.status}`);
    const data = (await res.json()) as { bid?: unknown; ask?: unknown };
    const bid = typeof data.bid === 'string' ? parseFloat(data.bid) : Number(data.bid);
    const ask = typeof data.ask === 'string' ? parseFloat(data.ask) : Number(data.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
      throw new Error('invalid bid/ask in coinbase ticker response');
    }
    quote = { bid, ask, ts: Date.now() };
    await env.DB.prepare(
      'INSERT INTO quotes (pair, ts, bid, ask, source) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(PAIR, quote.ts, quote.bid, quote.ask, 'coinbase')
      .run();
  } catch (e) {
    // Keep the last quote; the next tick retries.
    console.error('quote ingest failed; keeping last quote', e);
    return;
  }

  const open = await env.DB.prepare(
    `SELECT o.id, o.entry_id, o.pair, o.side, o.qty, o.limit_price
     FROM orders o
     JOIN season_entries e ON e.id = o.entry_id
     JOIN seasons s ON s.id = e.season_id
     WHERE o.status = 'open' AND o.type = 'limit' AND o.limit_price IS NOT NULL
       AND s.status = 'live' AND e.status = 'active'`,
  ).all<LimitOrderRow>();

  for (const order of open.results ?? []) {
    try {
      await fillLimitOrder(env, order);
    } catch (e) {
      // One bad order must not kill the batch.
      console.error('limit fill failed for order', order.id, e);
    }
  }
}

async function fillLimitOrder(env: Env, order: LimitOrderRow): Promise<void> {
  if (order.limit_price === null || order.limit_price <= 0) return;
  // Latest quote for the order's pair (v0.1 is BTC/USD only; the quote was just ingested).
  const q = await latestQuote(env, order.pair);
  if (!q) return;
  if (!limitTouched(q, order.side, order.limit_price)) return;

  const fillPrice = limitFillPrice(order.limit_price);

  const entry = await env.DB.prepare(
    'SELECT starting_capital, cash, status FROM season_entries WHERE id = ?',
  )
    .bind(order.entry_id)
    .first<{ starting_capital: number; cash: number; status: string }>();
  if (!entry || entry.status !== 'active') return;

  const pos = await env.DB.prepare(
    'SELECT qty, avg_price FROM positions WHERE entry_id = ? AND pair = ?',
  )
    .bind(order.entry_id, order.pair)
    .first<PositionRow>();
  const posQty = pos?.qty ?? 0;
  const avgPrice = pos?.avg_price ?? 0;

  // Same leverage guard as market fills: leave the order open if it fails.
  const lev = checkLeverage({
    cash: entry.cash,
    posQty,
    side: order.side,
    orderQty: order.qty,
    fillPrice,
  });
  if (!lev.ok) {
    console.error('limit fill blocked by leverage check', order.id, lev.reason ?? '');
    return;
  }

  const fill = applyFill({ qty: posQty, avgPrice }, order.side, order.qty, fillPrice);
  const newCash = entry.cash + fill.cashDelta;
  const now = Date.now();

  await env.DB.prepare('UPDATE season_entries SET cash = ? WHERE id = ?')
    .bind(newCash, order.entry_id)
    .run();
  await upsertPosition(env, order.entry_id, order.pair, fill.qty, fill.avgPrice);
  await env.DB.prepare(
    `UPDATE orders SET status = 'filled', fill_price = ?, filled_at = ?, realized_pnl = ?
     WHERE id = ? AND status = 'open'`,
  )
    .bind(fillPrice, now, fill.realizedPnl, order.id)
    .run();

  // Same liquidation guard as market fills.
  const equity = computeEquity(newCash, fill.qty, midPrice(q));
  if (shouldLiquidate(equity, entry.starting_capital)) {
    const closeSide: Side = fill.qty > 0 ? 'sell' : 'buy';
    if (fill.qty !== 0) {
      const closePrice = marketFillPrice(q, closeSide);
      const closeFill = applyFill(
        { qty: fill.qty, avgPrice: fill.avgPrice },
        closeSide,
        Math.abs(fill.qty),
        closePrice,
      );
      const finalCash = newCash + closeFill.cashDelta;
      await env.DB.prepare(
        "UPDATE season_entries SET cash = ?, status = 'liquidated' WHERE id = ?",
      )
        .bind(finalCash, order.entry_id)
        .run();
      await upsertPosition(env, order.entry_id, order.pair, 0, 0);
    } else {
      await env.DB.prepare("UPDATE season_entries SET status = 'liquidated' WHERE id = ?")
        .bind(order.entry_id)
        .run();
    }
  }
}

/**
 * 5-minute cron: snapshot equity for every active entry in live seasons,
 * recompute Alpha Scores, update ranks, and liquidate entries under water.
 */
export async function handleSnapshots(env: Env): Promise<void> {
  const entries = await env.DB.prepare(
    `SELECT se.id, se.season_id, se.starting_capital, se.cash, s.pair
     FROM season_entries se
     JOIN seasons s ON s.id = se.season_id
     WHERE se.status = 'active' AND s.status = 'live'`,
  ).all<EntryRow>();

  const quoteCache = new Map<string, Quote | null>();
  for (const entry of entries.results ?? []) {
    try {
      await snapshotEntry(env, entry, quoteCache);
    } catch (e) {
      // One bad entry must not kill the batch.
      console.error('snapshot failed for entry', entry.id, e);
    }
  }

  // Recompute rank per season: alpha_score desc, 1-based.
  const seasons = await env.DB.prepare(
    `SELECT DISTINCT se.season_id
     FROM season_entries se
     JOIN seasons s ON s.id = se.season_id
     WHERE s.status = 'live'`,
  ).all<{ season_id: string }>();
  for (const s of seasons.results ?? []) {
    const ranked = await env.DB.prepare(
      `SELECT sc.entry_id
       FROM scores sc
       JOIN season_entries se ON se.id = sc.entry_id
       WHERE se.season_id = ?
       ORDER BY sc.alpha_score DESC`,
    )
      .bind(s.season_id)
      .all<{ entry_id: string }>();
    let rank = 0;
    for (const r of ranked.results ?? []) {
      rank += 1;
      await env.DB.prepare('UPDATE scores SET rank = ? WHERE entry_id = ?')
        .bind(rank, r.entry_id)
        .run();
    }
  }
}

async function snapshotEntry(
  env: Env,
  entry: EntryRow,
  quoteCache: Map<string, Quote | null>,
): Promise<void> {
  let quote = quoteCache.get(entry.pair);
  if (quote === undefined) {
    quote = await latestQuote(env, entry.pair);
    quoteCache.set(entry.pair, quote);
  }
  if (!quote) return; // no market data yet; skip this entry

  const pos = await env.DB.prepare(
    'SELECT qty, avg_price FROM positions WHERE entry_id = ? AND pair = ?',
  )
    .bind(entry.id, entry.pair)
    .first<PositionRow>();
  const qty = pos?.qty ?? 0;
  const avgPrice = pos?.avg_price ?? 0;

  const mid = midPrice(quote);
  const equity = computeEquity(entry.cash, qty, mid);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO equity_snapshots (entry_id, ts, equity) VALUES (?, ?, ?)',
  )
    .bind(entry.id, now, equity)
    .run();

  if (shouldLiquidate(equity, entry.starting_capital)) {
    // Close the whole position at market, zero it, mark liquidated. Skip scoring.
    if (qty !== 0) {
      const closeSide: Side = qty > 0 ? 'sell' : 'buy';
      const closePrice = marketFillPrice(quote, closeSide);
      const closeFill = applyFill(
        { qty, avgPrice },
        closeSide,
        Math.abs(qty),
        closePrice,
      );
      const finalCash = entry.cash + closeFill.cashDelta;
      await env.DB.prepare(
        "UPDATE season_entries SET cash = ?, status = 'liquidated' WHERE id = ?",
      )
        .bind(finalCash, entry.id)
        .run();
      await upsertPosition(env, entry.id, entry.pair, 0, 0);
    } else {
      await env.DB.prepare("UPDATE season_entries SET status = 'liquidated' WHERE id = ?")
        .bind(entry.id)
        .run();
    }
    return;
  }

  // Score over the last 5000 snapshots, oldest first.
  const rows = await env.DB.prepare(
    'SELECT ts, equity FROM equity_snapshots WHERE entry_id = ? ORDER BY ts DESC LIMIT 5000',
  )
    .bind(entry.id)
    .all<{ ts: number; equity: number }>();
  const points: EquityPoint[] = (rows.results ?? [])
    .reverse()
    .map((r) => ({ ts: r.ts, equity: r.equity }));
  const score = computeAlphaScore(points, entry.starting_capital);

  await env.DB.prepare(
    `INSERT INTO scores
       (entry_id, total_return, sharpe, max_drawdown, win_rate, profit_factor, alpha_score, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (entry_id) DO UPDATE SET
       total_return = excluded.total_return,
       sharpe = excluded.sharpe,
       max_drawdown = excluded.max_drawdown,
       win_rate = excluded.win_rate,
       profit_factor = excluded.profit_factor,
       alpha_score = excluded.alpha_score,
       computed_at = excluded.computed_at`,
  )
    .bind(
      entry.id,
      score.totalReturn,
      score.sharpe,
      score.maxDrawdown,
      score.winRate,
      score.profitFactor,
      score.alphaScore,
      now,
    )
    .run();
}
