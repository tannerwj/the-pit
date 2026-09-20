// The Pit v0.1 — spectator read endpoints (public, no auth).
// Powers the exchange-style dashboard: equity sparklines + anonymized trade feed.
// Read-only; no new tables. All money is virtual.

import type { Env } from '../lib/types';
import { json, err } from '../lib/auth';
import { q, q1 } from '../lib/db';

function urlPairToDb(pair: string): string {
  return decodeURIComponent(pair).replace(/-/g, '/').toUpperCase();
}

/** Stable anonymized spectator label for an entry (entry ids are UUIDs). */
export function anonAgent(entryId: string): string {
  return 'Agent #' + entryId.slice(0, 4);
}

// GET /api/v1/entries/:id/equity?points=N (public)
// Downsampled equity curve for sparklines. points default 100, max 200.
export async function getEquityCurve(
  req: Request,
  env: Env,
  entryId: string,
): Promise<Response> {
  const entry = await q1<{ id: string }>(
    env.DB,
    'SELECT id FROM season_entries WHERE id = ?',
    entryId,
  );
  if (!entry) {
    return err('entry_not_found', 'Entry not found', 404);
  }

  const params = new URL(req.url).searchParams;
  let points = Number(params.get('points') ?? '100');
  if (!Number.isFinite(points) || points < 2) points = 100;
  points = Math.min(Math.floor(points), 200);

  const rows = await q<{ t: number; equity: number }>(
    env.DB,
    'SELECT ts AS t, equity FROM equity_snapshots WHERE entry_id = ? ORDER BY ts ASC',
    entryId,
  );

  let out: { t: number; equity: number }[];
  if (rows.length <= points) {
    out = rows;
  } else {
    out = [];
    const step = rows.length / points;
    for (let i = 0; i < points; i++) out.push(rows[Math.floor(i * step)]);
    out.push(rows[rows.length - 1]);
  }
  return json({ entry_id: entryId, points: out });
}

interface TradeRow {
  entry_id: string;
  side: string;
  qty: number;
  fill_price: number;
  filled_at: number;
}

// GET /api/v1/market/:pair/trades?limit=N (public)
// Recent filled orders in live seasons, anonymized. limit default 25, max 100.
export async function getRecentTrades(
  req: Request,
  env: Env,
  pair: string,
): Promise<Response> {
  const dbPair = urlPairToDb(pair);
  const params = new URL(req.url).searchParams;
  let limit = Number(params.get('limit') ?? '25');
  if (!Number.isFinite(limit) || limit < 1) limit = 25;
  limit = Math.min(Math.floor(limit), 100);

  const rows = await q<TradeRow>(
    env.DB,
    `SELECT o.entry_id, o.side, o.qty, o.fill_price, o.filled_at
     FROM orders o
     JOIN season_entries se ON se.id = o.entry_id
     JOIN seasons s ON s.id = se.season_id
     WHERE o.pair = ? AND o.status = 'filled'
       AND se.status != 'banned' AND s.status = 'live'
     ORDER BY o.filled_at DESC
     LIMIT ?`,
    dbPair,
    limit,
  );

  return json({
    pair: dbPair,
    trades: rows.map((r) => ({
      agent: anonAgent(r.entry_id),
      side: r.side,
      qty: r.qty,
      price: r.fill_price,
      ts: r.filled_at,
    })),
  });
}
