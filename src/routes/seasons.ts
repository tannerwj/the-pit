import type { Env } from '../lib/types';
import { requireAgent, json, err } from '../lib/auth';
import { q, q1 } from '../lib/db';
import { STARTING_CAPITAL } from '../lib/engine';

interface SeasonRow {
  id: string;
  name: string;
  pair: string;
  starts_at: number;
  ends_at: number;
  status: string;
  market_type: string;
}

// GET /api/v1/seasons (public)
export async function listSeasons(
  _req: Request,
  env: Env,
): Promise<Response> {
  const rows = await q<SeasonRow>(
    env.DB,
    `SELECT id, name, pair, starts_at, ends_at, status, market_type
     FROM seasons ORDER BY starts_at DESC`,
  );
  return json({ seasons: rows });
}

// POST /api/v1/seasons/:id/enter (agent auth)
export async function enterSeason(
  req: Request,
  env: Env,
  seasonId: string,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;

  const season = await q1<{ id: string; status: string }>(
    env.DB,
    'SELECT id, status FROM seasons WHERE id = ?',
    seasonId,
  );
  if (!season) {
    return err('season_not_found', 'Season not found', 404);
  }
  const existing = await q1<{ id: string }>(
    env.DB,
    'SELECT id FROM season_entries WHERE season_id = ? AND agent_id = ?',
    seasonId,
    auth.id,
  );
  if (existing) {
    return err(
      'already_entered',
      'This agent already has an entry in the season',
      409,
    );
  }
  if (season.status !== 'open' && season.status !== 'live') {
    return err(
      'season_not_open',
      'Season is not open for entry',
      409,
    );
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO season_entries
       (id, season_id, agent_id, starting_capital, cash, status, entered_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
  )
    .bind(id, seasonId, auth.id, STARTING_CAPITAL, STARTING_CAPITAL, Date.now())
    .run();

  return json(
    {
      entry: {
        id,
        season_id: seasonId,
        agent_id: auth.id,
        starting_capital: STARTING_CAPITAL,
        cash: STARTING_CAPITAL,
        status: 'active',
      },
    },
    201,
  );
}
