import type { Env } from '../lib/types';
import { requireAgent, json, err } from '../lib/auth';
import { q, q1 } from '../lib/db';
import { parseSeasonParams } from '../lib/leagues';

interface SeasonRow {
  id: string;
  name: string;
  pair: string;
  starts_at: number;
  ends_at: number;
  status: string;
  market_type: string;
  league_id: string | null;
  params: string | null;
}

// GET /api/v1/seasons (public)
export async function listSeasons(
  _req: Request,
  env: Env,
): Promise<Response> {
  const rows = await q<SeasonRow>(
    env.DB,
    `SELECT id, name, pair, starts_at, ends_at, status, market_type, league_id, params
     FROM seasons ORDER BY starts_at DESC`,
  );
  return json({
    seasons: rows.map((s) => ({
      id: s.id,
      name: s.name,
      pair: s.pair,
      starts_at: s.starts_at,
      ends_at: s.ends_at,
      status: s.status,
      market_type: s.market_type,
      league_id: s.league_id,
      params: parseSeasonParams(s.params),
    })),
  });
}

// POST /api/v1/seasons/:id/enter (agent auth)
// Body (optional): {invite_code} — required for private-league seasons.
export async function enterSeason(
  req: Request,
  env: Env,
  seasonId: string,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;

  const season = await q1<SeasonRow>(
    env.DB,
    'SELECT id, name, pair, starts_at, ends_at, status, market_type, league_id, params FROM seasons WHERE id = ?',
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

  const params = parseSeasonParams(season.params);

  // League gating: private leagues need a valid invite code; all leagues cap agents.
  if (season.league_id) {
    const league = await q1<{
      visibility: string;
      invite_code: string | null;
      max_agents: number;
    }>(
      env.DB,
      'SELECT visibility, invite_code, max_agents FROM leagues WHERE id = ?',
      season.league_id,
    );
    if (!league) {
      return err('season_not_found', 'Season not found', 404);
    }
    if (league.visibility === 'private') {
      let code: unknown;
      try {
        code = ((await req.json()) as Record<string, unknown>).invite_code;
      } catch {
        code = undefined;
      }
      if (typeof code !== 'string' || code !== league.invite_code) {
        return err(
          'invite_required',
          'This is a private league season: a valid invite_code is required',
          403,
        );
      }
    }
    const count = await q1<{ n: number }>(
      env.DB,
      'SELECT COUNT(*) AS n FROM season_entries WHERE season_id = ?',
      seasonId,
    );
    if ((count?.n ?? 0) >= league.max_agents) {
      return err(
        'league_full',
        `This league season is full (max ${league.max_agents} agents)`,
        409,
      );
    }
  }

  const capital = params.starting_capital;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO season_entries
       (id, season_id, agent_id, starting_capital, cash, status, entered_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
  )
    .bind(id, seasonId, auth.id, capital, capital, Date.now())
    .run();

  return json(
    {
      entry: {
        id,
        season_id: seasonId,
        agent_id: auth.id,
        starting_capital: capital,
        cash: capital,
        status: 'active',
      },
    },
    201,
  );
}
