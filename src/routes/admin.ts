import type { Env } from '../lib/types';
import type { EquityPoint } from '../lib/scoring';
import { json, err } from '../lib/auth';
import { q, q1, run } from '../lib/db';
import { computeAlphaScore } from '../lib/scoring';

interface SeasonRow {
  id: string;
  name: string;
  pair: string;
  starts_at: number;
  ends_at: number;
  status: string;
  market_type: string;
}

// POST /api/v1/admin/seasons (admin auth, applied by the router)
export async function createSeason(
  req: Request,
  env: Env,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err('bad_request', 'Request body must be JSON', 400);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const pair = typeof body.pair === 'string' ? body.pair : 'BTC/USD';
  const starts_at = body.starts_at as number;
  const ends_at = body.ends_at as number;

  if (name.length === 0 || name.length > 128) {
    return err('invalid_season', 'name must be 1-128 characters', 422);
  }
  if (pair.length === 0) {
    return err('invalid_season', 'pair is required', 422);
  }
  if (
    typeof starts_at !== 'number' ||
    typeof ends_at !== 'number' ||
    !Number.isFinite(starts_at) ||
    !Number.isFinite(ends_at)
  ) {
    return err(
      'invalid_season',
      'starts_at and ends_at must be unix ms timestamps',
      422,
    );
  }
  if (!(starts_at < ends_at)) {
    return err('invalid_season', 'starts_at must be before ends_at', 422);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO seasons (id, name, pair, starts_at, ends_at, status, market_type, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', 'real', ?)`,
  )
    .bind(id, name, pair, starts_at, ends_at, Date.now())
    .run();

  return json(
    {
      season: {
        id,
        name,
        pair,
        starts_at,
        ends_at,
        status: 'open',
        market_type: 'real',
      },
    },
    201,
  );
}

async function settleSeason(env: Env, seasonId: string): Promise<void> {
  const entries = await q<{ id: string; starting_capital: number }>(
    env.DB,
    'SELECT id, starting_capital FROM season_entries WHERE season_id = ?',
    seasonId,
  );
  const scored: { entryId: string; alphaScore: number }[] = [];
  const now = Date.now();
  for (const e of entries) {
    const snaps = await q<{ ts: number; equity: number }>(
      env.DB,
      'SELECT ts, equity FROM equity_snapshots WHERE entry_id = ? ORDER BY ts ASC',
      e.id,
    );
    if (snaps.length < 2) continue; // not scored -> stays null in leaderboard
    const points: EquityPoint[] = snaps.map((s) => ({
      ts: s.ts,
      equity: s.equity,
    }));
    const sc = computeAlphaScore(points, e.starting_capital);
    await env.DB.prepare(
      `INSERT INTO scores
         (entry_id, total_return, sharpe, max_drawdown, win_rate, profit_factor, alpha_score, rank, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(entry_id) DO UPDATE SET
         total_return = excluded.total_return,
         sharpe = excluded.sharpe,
         max_drawdown = excluded.max_drawdown,
         win_rate = excluded.win_rate,
         profit_factor = excluded.profit_factor,
         alpha_score = excluded.alpha_score,
         rank = NULL,
         computed_at = excluded.computed_at`,
    )
      .bind(
        e.id,
        sc.totalReturn,
        sc.sharpe,
        sc.maxDrawdown,
        sc.winRate,
        sc.profitFactor,
        sc.alphaScore,
        now,
      )
      .run();
    scored.push({ entryId: e.id, alphaScore: sc.alphaScore });
  }
  scored.sort((a, b) => b.alphaScore - a.alphaScore);
  for (let i = 0; i < scored.length; i++) {
    await run(env.DB, 'UPDATE scores SET rank = ? WHERE entry_id = ?', i + 1, scored[i].entryId);
  }
  await run(env.DB, "UPDATE seasons SET status = 'settled' WHERE id = ?", seasonId);
}

export type SeasonAction = 'open' | 'close' | 'settle';

// POST /api/v1/admin/seasons/:id/open|/close|/settle (admin auth, applied by the router)
export async function seasonTransition(
  _req: Request,
  env: Env,
  seasonId: string,
  action: SeasonAction,
): Promise<Response> {
  const season = await q1<SeasonRow>(
    env.DB,
    'SELECT id, name, pair, starts_at, ends_at, status, market_type FROM seasons WHERE id = ?',
    seasonId,
  );
  if (!season) {
    return err('season_not_found', 'Season not found', 404);
  }
  const current = season.status;

  if (action === 'open') {
    // "open" auto-advances an open season to live (trading allowed);
    // re-opens a closed season for entry. Settled seasons are final.
    if (current === 'settled') {
      return err('bad_transition', 'Settled seasons cannot be re-opened', 409);
    }
    const next = current === 'closed' ? 'open' : 'live';
    await run(env.DB, 'UPDATE seasons SET status = ? WHERE id = ?', next, seasonId);
    return json({ season: { ...season, status: next } });
  }
  if (action === 'close') {
    // live -> closed only
    if (current !== 'live' && current !== 'closed') {
      return err(
        'bad_transition',
        `Cannot close a season in status '${current}'`,
        409,
      );
    }
    await run(env.DB, "UPDATE seasons SET status = 'closed' WHERE id = ?", seasonId);
    return json({ season: { ...season, status: 'closed' } });
  }
  // action === 'settle': closed -> settled, computing final scores
  if (current !== 'closed' && current !== 'settled') {
    return err(
      'bad_transition',
      `Cannot settle a season in status '${current}'`,
      409,
    );
  }
  if (current === 'settled') {
    return json({ season });
  }
  await settleSeason(env, seasonId);
  return json({ season: { ...season, status: 'settled' } });
}

// POST /api/v1/admin/agents/:id/ban|/unban (admin auth, applied by the router)
export async function banAgent(
  _req: Request,
  env: Env,
  agentId: string,
  ban: boolean,
): Promise<Response> {
  const agent = await q1<{ id: string }>(
    env.DB,
    'SELECT id FROM agents WHERE id = ?',
    agentId,
  );
  if (!agent) {
    return err('agent_not_found', 'Agent not found', 404);
  }
  const status = ban ? 'banned' : 'active';
  await run(env.DB, 'UPDATE agents SET status = ? WHERE id = ?', status, agentId);
  return json({ agent: { id: agentId, status } });
}

// POST /api/v1/admin/entries/:id/takedown (admin auth, applied by the router)
export async function takedownEntry(
  _req: Request,
  env: Env,
  entryId: string,
): Promise<Response> {
  const entry = await q1<{
    id: string;
    season_id: string;
    agent_id: string;
    starting_capital: number;
    cash: number;
    entered_at: number;
  }>(
    env.DB,
    `SELECT id, season_id, agent_id, starting_capital, cash, entered_at
     FROM season_entries WHERE id = ?`,
    entryId,
  );
  if (!entry) {
    return err('entry_not_found', 'Entry not found', 404);
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE season_entries SET status = 'banned' WHERE id = ?").bind(entryId),
    env.DB.prepare(
      "UPDATE orders SET status = 'cancelled' WHERE entry_id = ? AND status = 'open'",
    ).bind(entryId),
  ]);
  return json({ entry: { ...entry, status: 'banned' } });
}

// GET /api/v1/admin/entries/:id/journal (admin auth, applied by the router)
export async function adminJournal(
  _req: Request,
  env: Env,
  entryId: string,
): Promise<Response> {
  const entry = await q1<{
    id: string;
    season_id: string;
    agent_id: string;
    starting_capital: number;
    cash: number;
    status: string;
    entered_at: number;
    agent_email: string;
    agent_name: string;
  }>(
    env.DB,
    `SELECT e.id, e.season_id, e.agent_id, e.starting_capital, e.cash, e.status, e.entered_at,
            a.email AS agent_email, a.name AS agent_name
     FROM season_entries e JOIN agents a ON a.id = e.agent_id
     WHERE e.id = ?`,
    entryId,
  );
  if (!entry) {
    return err('entry_not_found', 'Entry not found', 404);
  }
  const orders = await q(
    env.DB,
    `SELECT id, entry_id, pair, side, qty, type, limit_price, rationale, status,
            created_at, filled_at, fill_price, realized_pnl
     FROM orders WHERE entry_id = ? ORDER BY created_at DESC, id DESC`,
    entryId,
  );
  return json({
    entry_id: entryId,
    entry: {
      id: entry.id,
      season_id: entry.season_id,
      starting_capital: entry.starting_capital,
      cash: entry.cash,
      status: entry.status,
      entered_at: entry.entered_at,
    },
    agent: {
      id: entry.agent_id,
      email: entry.agent_email,
      name: entry.agent_name,
    },
    orders,
  });
}
