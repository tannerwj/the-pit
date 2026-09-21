import type { Env, Quote, Side } from '../lib/types';
import { requireAgent, json, err } from '../lib/auth';
import { q, q1 } from '../lib/db';
import {
  marketFillPrice,
  limitFillPrice,
  applyFill,
  checkLeverage,
  computeEquity,
} from '../lib/engine';
import { enqueueWebhookEvent } from '../lib/webhooks';
import { SUPPORTED_PAIRS, parseSeasonParams } from '../lib/leagues';

const QUOTE_TTL_MS = 120_000; // 120s staleness cutoff for inline market fills

interface SeasonRow {
  id: string;
  pair: string;
  status: string;
  params: string | null;
}
interface EntryRow {
  id: string;
  season_id: string;
  agent_id: string;
  cash: number;
  status: string;
  starting_capital: number;
}
interface OrderRow {
  id: string;
  entry_id: string;
  pair: string;
  side: string;
  qty: number;
  type: string;
  limit_price: number | null;
  rationale: string;
  status: string;
  created_at: number;
  filled_at: number | null;
  fill_price: number | null;
  realized_pnl: number | null;
}
interface PosRow {
  qty: number;
  avg_price: number;
}
interface QuoteRow {
  bid: number;
  ask: number;
  ts: number;
  source: string;
}

function orderJson(o: OrderRow) {
  return {
    id: o.id,
    entry_id: o.entry_id,
    pair: o.pair,
    side: o.side,
    qty: o.qty,
    type: o.type,
    limit_price: o.limit_price,
    rationale: o.rationale,
    status: o.status,
    fill_price: o.fill_price,
    filled_at: o.filled_at,
    realized_pnl: o.realized_pnl,
    created_at: o.created_at,
  };
}

async function fetchCoinbaseQuote(
  pair: string,
): Promise<(Quote & { source: string }) | null> {
  const urlPair = pair.replace('/', '-'); // BTC/USD -> BTC-USD
  try {
    const res = await fetch(
      `https://api.exchange.coinbase.com/products/${urlPair}/ticker`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      bid?: unknown;
      ask?: unknown;
      time?: unknown;
    };
    const bid = Number(data.bid);
    const ask = Number(data.ask);
    if (!(bid > 0) || !(ask > 0)) return null;
    const ts =
      typeof data.time === 'string' && data.time
        ? Date.parse(data.time)
        : NaN;
    return {
      bid,
      ask,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      source: 'coinbase',
    };
  } catch {
    return null;
  }
}

// Latest quote for the pair; if missing or older than 120s, fetch fresh
// inline from Coinbase (and persist it). Returns null when no data at all.
async function getMarketQuote(
  env: Env,
  pair: string,
): Promise<(Quote & { source: string }) | null> {
  const row = await q1<QuoteRow>(
    env.DB,
    'SELECT bid, ask, ts, source FROM quotes WHERE pair = ? ORDER BY ts DESC LIMIT 1',
    pair,
  );
  const now = Date.now();
  if (row && now - row.ts <= QUOTE_TTL_MS) {
    return { bid: row.bid, ask: row.ask, ts: row.ts, source: row.source };
  }
  const fresh = await fetchCoinbaseQuote(pair);
  if (!fresh) return null;
  await env.DB.prepare(
    'INSERT INTO quotes (pair, ts, bid, ask, source) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(pair, fresh.ts, fresh.bid, fresh.ask, fresh.source)
    .run();
  return fresh;
}

// POST /api/v1/orders (agent auth)
export async function placeOrder(
  req: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err('bad_request', 'Request body must be JSON', 400);
  }
  const season_id = body.season_id as string;
  const pair = body.pair as string;
  const side = body.side as Side;
  const qty = body.qty as number;
  const type = body.type as string;
  const limit_price = body.limit_price as number | undefined;
  const rationale = body.rationale as string;

  // 1. rationale (first failure wins)
  if (typeof rationale !== 'string' || rationale.trim().length < 3) {
    return err(
      'rationale_required',
      'A trade rationale of at least 3 characters is required',
      422,
    );
  }
  // Season lookup (needed for params + live checks below)
  const season = await q1<SeasonRow>(
    env.DB,
    'SELECT id, pair, status, params FROM seasons WHERE id = ?',
    season_id,
  );
  if (!season) {
    return err('season_not_found', 'Season not found', 404);
  }
  const sparams = parseSeasonParams(season.params);
  // 2. pair must be one of the season's tradable pairs
  if (
    typeof pair !== 'string' ||
    !(SUPPORTED_PAIRS as readonly string[]).includes(pair) ||
    !sparams.pairs.includes(pair)
  ) {
    return err(
      'bad_pair',
      `Order pair must be one of the season's pairs: ${sparams.pairs.join(', ')}`,
      422,
    );
  }
  // 3. side/qty/type/limit_price
  if (
    (side !== 'buy' && side !== 'sell') ||
    typeof qty !== 'number' ||
    !(qty > 0) ||
    qty > 100
  ) {
    return err(
      'bad_order',
      'side must be buy or sell and qty must be > 0 and <= 100',
      422,
    );
  }
  if (type !== 'market' && type !== 'limit') {
    return err('bad_order', 'type must be market or limit', 422);
  }
  if (
    type === 'limit' &&
    (typeof limit_price !== 'number' || !(limit_price > 0))
  ) {
    return err('bad_order', 'limit orders require limit_price > 0', 422);
  }
  // 4. entry must exist and be active
  const entry = await q1<EntryRow>(
    env.DB,
    `SELECT id, season_id, agent_id, cash, status, starting_capital
     FROM season_entries WHERE season_id = ? AND agent_id = ?`,
    season_id,
    auth.id,
  );
  if (!entry || entry.status !== 'active') {
    return err(
      'entry_closed',
      'No active entry for this agent in the season',
      409,
    );
  }
  // 5. season must be live
  if (season.status !== 'live') {
    return err('season_not_live', 'Season is not live for trading', 409);
  }
  // 6. position load + short rule (no quote needed; pure math)
  const pos = await q1<PosRow>(
    env.DB,
    'SELECT qty, avg_price FROM positions WHERE entry_id = ? AND pair = ?',
    entry.id,
    pair,
  );
  const posQty = pos?.qty ?? 0;
  const posAvg = pos?.avg_price ?? 0;
  if (!sparams.allow_short && side === 'sell') {
    const after = applyFill({ qty: posQty, avgPrice: posAvg }, side, qty, 1);
    if (after.qty < 0) {
      return err(
        'shorts_disallowed',
        'Short selling is disabled in this season',
        422,
      );
    }
  }
  // 7. leverage check at fill price (season's max_leverage)
  let fillPrice: number;
  if (type === 'market') {
    const quote = await getMarketQuote(env, pair);
    if (!quote) {
      return err('no_market_data', 'No fresh market data available', 503);
    }
    fillPrice = marketFillPrice(quote, side);
  } else {
    fillPrice = limitFillPrice(limit_price as number);
  }
  const leverage = checkLeverage({
    cash: entry.cash,
    posQty,
    side,
    orderQty: qty,
    fillPrice,
    maxLeverage: sparams.max_leverage,
  });
  if (!leverage.ok) {
    return err(
      'leverage_exceeded',
      leverage.reason ?? 'Order would exceed the leverage limit',
      422,
    );
  }

  // 8. persist the order; market orders fill immediately, limit orders rest open
  const id = crypto.randomUUID();
  const now = Date.now();
  const trimmedRationale = rationale.trim();
  await env.DB.prepare(
    `INSERT INTO orders
       (id, entry_id, pair, side, qty, type, limit_price, rationale, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  )
    .bind(
      id,
      entry.id,
      pair,
      side,
      qty,
      type,
      type === 'limit' ? (limit_price as number) : null,
      trimmedRationale,
      now,
    )
    .run();

  let status = 'open';
  let filledAt: number | null = null;
  let filledPrice: number | null = null;
  let realizedPnl = 0;
  if (type === 'market') {
    const fill = applyFill(
      { qty: posQty, avgPrice: posAvg },
      side,
      qty,
      fillPrice,
    );
    filledAt = Date.now();
    filledPrice = fillPrice;
    realizedPnl = fill.realizedPnl;
    status = 'filled';
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO positions (entry_id, pair, qty, avg_price, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(entry_id, pair) DO UPDATE SET
           qty = excluded.qty,
           avg_price = excluded.avg_price,
           updated_at = excluded.updated_at`,
      ).bind(entry.id, pair, fill.qty, fill.avgPrice, filledAt),
      env.DB.prepare('UPDATE season_entries SET cash = cash + ? WHERE id = ?')
        .bind(fill.cashDelta, entry.id),
      env.DB.prepare(
        `UPDATE orders SET status = 'filled', fill_price = ?, filled_at = ?, realized_pnl = ?
         WHERE id = ?`,
      ).bind(fillPrice, filledAt, fill.realizedPnl, id),
    ]);

    // Webhook: order.filled (never blocks the fill path; failures are swallowed).
    const equityAfter = computeEquity(entry.cash + fill.cashDelta, fill.qty, fillPrice);
    await enqueueWebhookEvent(env, ctx, auth.id, 'order.filled', {
      season_id: season.id,
      entry_id: entry.id,
      order_id: id,
      pair,
      side,
      qty,
      type: 'market',
      fill_price: fillPrice,
      realized_pnl: realizedPnl,
      equity_after: equityAfter,
      entry_status: 'active',
    });
  }

  return json(
    {
      order: orderJson({
        id,
        entry_id: entry.id,
        pair,
        side,
        qty,
        type,
        limit_price: type === 'limit' ? (limit_price as number) : null,
        rationale: trimmedRationale,
        status,
        created_at: now,
        filled_at: filledAt,
        fill_price: filledPrice,
        realized_pnl: realizedPnl,
      }),
    },
    201,
  );
}

// GET /api/v1/orders?season_id= (agent auth, owner only, newest first)
export async function listOrders(
  req: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;
  const seasonId = new URL(req.url).searchParams.get('season_id');
  if (!seasonId) {
    return err(
      'season_id_required',
      'season_id query param is required',
      400,
    );
  }
  const entry = await q1<{ id: string }>(
    env.DB,
    'SELECT id FROM season_entries WHERE season_id = ? AND agent_id = ?',
    seasonId,
    auth.id,
  );
  if (!entry) {
    return err(
      'entry_not_found',
      'No entry for this agent in the season',
      404,
    );
  }
  const rows = await q<OrderRow>(
    env.DB,
    `SELECT id, entry_id, pair, side, qty, type, limit_price, rationale, status,
            created_at, filled_at, fill_price, realized_pnl
     FROM orders WHERE entry_id = ? ORDER BY created_at DESC, id DESC`,
    entry.id,
  );
  return json({ orders: rows.map(orderJson) });
}

// DELETE /api/v1/orders/:id (agent auth, cancel own open order)
export async function cancelOrder(
  req: Request,
  env: Env,
  orderId: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;
  const order = await q1<OrderRow>(
    env.DB,
    `SELECT o.id, o.entry_id, o.pair, o.side, o.qty, o.type, o.limit_price, o.rationale,
            o.status, o.created_at, o.filled_at, o.fill_price, o.realized_pnl,
            e.season_id AS season_id
     FROM orders o
     JOIN season_entries e ON e.id = o.entry_id
     WHERE o.id = ? AND e.agent_id = ?`,
    orderId,
    auth.id,
  );
  if (!order) {
    return err('order_not_found', 'Order not found', 404);
  }
  if (order.status !== 'open') {
    return err(
      'already_filled',
      `Order is already ${order.status} and cannot be cancelled`,
      409,
    );
  }
  await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?")
    .bind(orderId)
    .run();
  // Webhook: order.cancelled (never blocks the cancel path).
  await enqueueWebhookEvent(env, ctx, auth.id, 'order.cancelled', {
    season_id: (order as OrderRow & { season_id: string }).season_id,
    entry_id: order.entry_id,
    order_id: order.id,
    pair: order.pair,
    side: order.side,
    qty: order.qty,
    type: order.type,
    limit_price: order.limit_price,
  });
  return json({ order: orderJson({ ...order, status: 'cancelled' }) });
}
