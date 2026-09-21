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
import { parseSeasonParams, SUPPORTED_PAIRS } from './lib/leagues';
import { computeAlphaScore } from './lib/scoring';
import type { EquityPoint } from './lib/scoring';
import { settleSeason } from './routes/admin';
import { drainWebhookOutbox, enqueueWebhookEvent } from './lib/webhooks';

function tickerUrl(pair: string): string {
  return `https://api.exchange.coinbase.com/products/${pair.replace('/', '-')}/ticker`;
}

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
  agent_id: string;
  starting_capital: number;
  cash: number;
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
 * 1-minute cron: ingest the Coinbase ticker for every supported pair, then
 * match open limit orders in live seasons against the fresh quotes.
 */
export async function handleQuoteIngest(
  env: Env,
  ctx?: ExecutionContext,
): Promise<void> {
  for (const pair of SUPPORTED_PAIRS) {
    try {
      const res = await fetch(tickerUrl(pair));
      if (!res.ok) throw new Error(`coinbase ticker HTTP ${res.status} for ${pair}`);
      const data = (await res.json()) as { bid?: unknown; ask?: unknown };
      const bid = typeof data.bid === 'string' ? parseFloat(data.bid) : Number(data.bid);
      const ask = typeof data.ask === 'string' ? parseFloat(data.ask) : Number(data.ask);
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
        throw new Error(`invalid bid/ask in coinbase ticker response for ${pair}`);
      }
      await env.DB.prepare(
        // OR IGNORE: the UNIQUE(pair, ts, source) index (migration 0004) makes
        // quote ingest idempotent instead of failing on a rare ts collision.
        'INSERT OR IGNORE INTO quotes (pair, ts, bid, ask, source) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(pair, Date.now(), bid, ask, 'coinbase')
        .run();
    } catch (e) {
      // Keep the last quote for this pair; the next tick retries.
      console.error('quote ingest failed; keeping last quote', pair, e);
    }
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
      await fillLimitOrder(env, order, ctx);
    } catch (e) {
      // One bad order must not kill the batch.
      console.error('limit fill failed for order', order.id, e);
    }
  }

  // Webhook outbox: retry pending deliveries whose backoff has elapsed.
  try {
    await drainWebhookOutbox(env);
  } catch (e) {
    console.error('webhook outbox drain failed', e);
  }
}

async function fillLimitOrder(
  env: Env,
  order: LimitOrderRow,
  ctx?: ExecutionContext,
): Promise<void> {
  if (order.limit_price === null || order.limit_price <= 0) return;
  // Latest quote for the order's pair (each supported pair was just ingested).
  const q = await latestQuote(env, order.pair);
  if (!q) return;
  if (!limitTouched(q, order.side, order.limit_price)) return;

  const fillPrice = limitFillPrice(order.limit_price);

  const entry = await env.DB.prepare(
    `SELECT se.id, se.season_id, se.agent_id, se.starting_capital, se.cash, se.status, s.params
     FROM season_entries se
     JOIN seasons s ON s.id = se.season_id
     WHERE se.id = ?`,
  )
    .bind(order.entry_id)
    .first<{ id: string; season_id: string; agent_id: string; starting_capital: number; cash: number; status: string; params: string | null }>();
  if (!entry || entry.status !== 'active') return;
  const sparams = parseSeasonParams(entry.params);

  const pos = await env.DB.prepare(
    'SELECT qty, avg_price FROM positions WHERE entry_id = ? AND pair = ?',
  )
    .bind(order.entry_id, order.pair)
    .first<PositionRow>();
  const posQty = pos?.qty ?? 0;
  const avgPrice = pos?.avg_price ?? 0;

  // Same leverage guard as market fills (season's max_leverage): leave open if it fails.
  const lev = checkLeverage({
    cash: entry.cash,
    posQty,
    side: order.side,
    orderQty: order.qty,
    fillPrice,
    maxLeverage: sparams.max_leverage,
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

  // Webhook: order.filled (never blocks the fill path).
  const equityAfterFill = computeEquity(newCash, fill.qty, midPrice(q));
  await enqueueWebhookEvent(env, ctx, entry.agent_id, 'order.filled', {
    season_id: entry.season_id,
    entry_id: order.entry_id,
    order_id: order.id,
    pair: order.pair,
    side: order.side,
    qty: order.qty,
    type: 'limit',
    fill_price: fillPrice,
    realized_pnl: fill.realizedPnl,
    equity_after: equityAfterFill,
    entry_status: 'active',
  });

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
      // Webhook: position.liquidated.
      await enqueueWebhookEvent(env, ctx, entry.agent_id, 'position.liquidated', {
        season_id: entry.season_id,
        entry_id: order.entry_id,
        trigger: 'order_fill',
        pairs_closed: [order.pair],
        equity_after: finalCash,
        entry_status: 'liquidated',
      });
    } else {
      await env.DB.prepare("UPDATE season_entries SET status = 'liquidated' WHERE id = ?")
        .bind(order.entry_id)
        .run();
      await enqueueWebhookEvent(env, ctx, entry.agent_id, 'position.liquidated', {
        season_id: entry.season_id,
        entry_id: order.entry_id,
        trigger: 'order_fill',
        pairs_closed: [],
        equity_after: newCash,
        entry_status: 'liquidated',
      });
    }
  }
}

/**
 * 5-minute cron: snapshot equity for every active entry in live seasons,
 * recompute Alpha Scores, update ranks, and liquidate entries under water.
 */
export async function handleSnapshots(
  env: Env,
  ctx?: ExecutionContext,
): Promise<void> {
  const entries = await env.DB.prepare(
    `SELECT se.id, se.season_id, se.agent_id, se.starting_capital, se.cash
     FROM season_entries se
     JOIN seasons s ON s.id = se.season_id
     WHERE se.status = 'active' AND s.status = 'live'`,
  ).all<EntryRow>();

  const quoteCache = new Map<string, Quote | null>();
  for (const entry of entries.results ?? []) {
    try {
      await snapshotEntry(env, entry, quoteCache, ctx);
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
  ctx?: ExecutionContext,
): Promise<void> {
  // Multi-pair: mark every open position at its pair's latest mid.
  const positions = await env.DB.prepare(
    'SELECT pair, qty, avg_price FROM positions WHERE entry_id = ? AND qty != 0',
  )
    .bind(entry.id)
    .all<{ pair: string; qty: number; avg_price: number }>();

  let equity = entry.cash;
  const marked: { pair: string; qty: number; avgPrice: number; mid: number | null }[] = [];
  for (const p of positions.results ?? []) {
    let quote = quoteCache.get(p.pair);
    if (quote === undefined) {
      quote = await latestQuote(env, p.pair);
      quoteCache.set(p.pair, quote);
    }
    const mid = quote ? midPrice(quote) : null;
    // Pairs with no quote yet are marked at their average entry price.
    const mark = mid ?? p.avg_price;
    equity += p.qty * mark;
    marked.push({ pair: p.pair, qty: p.qty, avgPrice: p.avg_price, mid });
  }
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO equity_snapshots (entry_id, ts, equity) VALUES (?, ?, ?)',
  )
    .bind(entry.id, now, equity)
    .run();

  if (shouldLiquidate(equity, entry.starting_capital)) {
    // Close every open position at market, zero them, mark liquidated. Skip scoring.
    let cash = entry.cash;
    const closedPairs: string[] = [];
    for (const m of marked) {
      if (m.qty === 0) continue;
      const closeSide: Side = m.qty > 0 ? 'sell' : 'buy';
      const q = await latestQuote(env, m.pair);
      const closePrice = q ? marketFillPrice(q, closeSide) : m.avgPrice;
      const closeFill = applyFill(
        { qty: m.qty, avgPrice: m.avgPrice },
        closeSide,
        Math.abs(m.qty),
        closePrice,
      );
      cash += closeFill.cashDelta;
      closedPairs.push(m.pair);
      await upsertPosition(env, entry.id, m.pair, 0, 0);
    }
    await env.DB.prepare(
      "UPDATE season_entries SET cash = ?, status = 'liquidated' WHERE id = ?",
    )
      .bind(cash, entry.id)
      .run();
    // Webhook: position.liquidated (never blocks the snapshot path).
    await enqueueWebhookEvent(env, ctx, entry.agent_id, 'position.liquidated', {
      season_id: entry.season_id,
      entry_id: entry.id,
      trigger: 'snapshot',
      pairs_closed: closedPairs,
      equity_after: cash,
      entry_status: 'liquidated',
    });
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

interface TransitionSeasonRow {
  id: string;
  starts_at: number;
  ends_at: number;
  status: 'open' | 'live' | 'closed' | 'settled';
}

/**
 * 1-minute cron (part 2): auto-transition OFFICIAL seasons through their
 * lifecycle based on wall-clock time. League seasons (league_id NOT NULL)
 * are deliberately excluded — league creators drive those manually via the
 * creator transition endpoints.
 *
 * - status='open'   AND now >= starts_at -> 'live'   (trading begins)
 * - status='live'   AND now >= ends_at   -> close + settleSeason()
 *   (final scores, ranks, status='settled')
 *
 * Idempotent: each transition is guarded on the current status, so a repeat
 * tick is a no-op. Mirrors the admin seasonTransition handler's exact
 * sequence (close flip, then settleSeason) without reimplementing scoring.
 */
export async function handleSeasonTransitions(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, starts_at, ends_at, status FROM seasons
     WHERE league_id IS NULL AND status IN ('open', 'live')`,
  ).all<TransitionSeasonRow>();

  const now = Date.now();
  for (const s of rows.results ?? []) {
    try {
      if (s.status === 'open' && now >= s.starts_at) {
        await env.DB.prepare("UPDATE seasons SET status = 'live' WHERE id = ? AND status = 'open'")
          .bind(s.id)
          .run();
      } else if (s.status === 'live' && now >= s.ends_at) {
        // Same sequence as the admin close+settle endpoints: live -> closed,
        // then settleSeason (final scores, ranks, -> settled).
        await env.DB.prepare("UPDATE seasons SET status = 'closed' WHERE id = ? AND status = 'live'")
          .bind(s.id)
          .run();
        await settleSeason(env, s.id);
      }
    } catch (e) {
      // One bad season must not kill the batch.
      console.error('season auto-transition failed for season', s.id, e);
    }
  }
}
