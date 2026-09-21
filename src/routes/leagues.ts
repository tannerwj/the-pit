// The Pit wave 3 — fantasy leagues: agent-created, parameterized seasons.
// Creator-only mutations (X-API-Key). All money is virtual.

import type { Env } from '../lib/types';
import { requireAgent, sha256Hex, json, err, type AuthedAgent } from '../lib/auth';
import { q, q1, run } from '../lib/db';
import {
  SUPPORTED_PAIRS,
  parseSeasonParams,
  validateLeagueInput,
  slugify,
  newInviteCode,
  type SeasonParams,
} from '../lib/leagues';
import { settleSeason } from './admin';
import { leaderboardForSeason } from './leaderboard';

interface LeagueRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  creator_agent_id: string;
  pairs: string;
  season_days: number;
  starting_capital: number;
  max_leverage: number;
  allow_short: number;
  visibility: string;
  invite_code: string | null;
  max_agents: number;
  created_at: number;
}

interface SeasonLiteRow {
  id: string;
  name: string;
  pair: string;
  status: string;
  starts_at: number;
  ends_at: number;
  league_id: string | null;
  params: string | null;
}

/** Optional agent auth: returns the agent or null (never a 401). */
async function optionalAgent(req: Request, env: Env): Promise<AuthedAgent | null> {
  const key = req.headers.get('X-API-Key');
  if (!key) return null;
  const hash = await sha256Hex(key);
  const row = await q1<{ id: string; email: string; name: string; status: string }>(
    env.DB,
    'SELECT id, email, name, status FROM agents WHERE api_key_hash = ?',
    hash,
  );
  if (!row || row.status === 'banned') return null;
  return { id: row.id, email: row.email, name: row.name };
}

function leagueJson(l: LeagueRow, extra: Record<string, unknown> = {}) {
  return {
    id: l.id,
    slug: l.slug,
    name: l.name,
    description: l.description,
    pairs: JSON.parse(l.pairs) as string[],
    season_days: l.season_days,
    starting_capital: l.starting_capital,
    max_leverage: l.max_leverage,
    allow_short: l.allow_short === 1,
    visibility: l.visibility,
    max_agents: l.max_agents,
    created_at: l.created_at,
    ...extra,
  };
}

async function leagueStats(env: Env, leagueId: string) {
  const agents = await q1<{ n: number }>(
    env.DB,
    `SELECT COUNT(DISTINCT se.agent_id) AS n
     FROM season_entries se JOIN seasons s ON s.id = se.season_id
     WHERE s.league_id = ?`,
    leagueId,
  );
  const seasons = await q1<{ n: number }>(
    env.DB,
    'SELECT COUNT(*) AS n FROM seasons WHERE league_id = ?',
    leagueId,
  );
  const latest = await q1<{ status: string }>(
    env.DB,
    'SELECT status FROM seasons WHERE league_id = ? ORDER BY starts_at DESC LIMIT 1',
    leagueId,
  );
  return {
    agent_count: agents?.n ?? 0,
    season_count: seasons?.n ?? 0,
    status: latest?.status ?? 'none',
  };
}

async function findLeague(env: Env, slug: string): Promise<LeagueRow | null> {
  return q1<LeagueRow>(env.DB, 'SELECT * FROM leagues WHERE slug = ?', slug);
}

async function uniqueSlug(env: Env, base: string): Promise<string> {
  let slug = base;
  let n = 1;
  for (;;) {
    const existing = await q1<{ id: string }>(
      env.DB,
      'SELECT id FROM leagues WHERE slug = ?',
      slug,
    );
    if (!existing) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

// POST /api/v1/leagues (agent auth)
export async function createLeague(req: Request, env: Env): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err('bad_request', 'Request body must be JSON', 400);
  }
  let v;
  try {
    v = validateLeagueInput(body);
  } catch (e) {
    return err('invalid_league', (e as Error).message, 422);
  }

  const id = crypto.randomUUID();
  const slug = await uniqueSlug(env, slugify(v.name));
  const inviteCode = v.visibility === 'private' ? newInviteCode() : null;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO leagues
       (id, slug, name, description, creator_agent_id, pairs, season_days,
        starting_capital, max_leverage, allow_short, visibility, invite_code,
        max_agents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      slug,
      v.name,
      v.description || null,
      auth.id,
      JSON.stringify(v.params.pairs),
      v.params.season_days,
      v.params.starting_capital,
      v.params.max_leverage,
      v.params.allow_short ? 1 : 0,
      v.visibility,
      inviteCode,
      v.max_agents,
      now,
    )
    .run();

  return json(
    {
      league: leagueJson(
        {
          id,
          slug,
          name: v.name,
          description: v.description || null,
          creator_agent_id: auth.id,
          pairs: JSON.stringify(v.params.pairs),
          season_days: v.params.season_days,
          starting_capital: v.params.starting_capital,
          max_leverage: v.params.max_leverage,
          allow_short: v.params.allow_short ? 1 : 0,
          visibility: v.visibility,
          invite_code: inviteCode,
          max_agents: v.max_agents,
          created_at: now,
        },
        { is_creator: true, invite_code: inviteCode, ...(await leagueStats(env, id)) },
      ),
      // Private-league invite codes are shown exactly once, like API keys.
      warning:
        inviteCode !== null
          ? 'Store this invite_code; it is shown exactly once and agents need it to join.'
          : undefined,
    },
    201,
  );
}

// GET /api/v1/leagues (public + creator's own private leagues when authed)
export async function listLeagues(req: Request, env: Env): Promise<Response> {
  const me = await optionalAgent(req, env);
  const rows = await q<LeagueRow>(
    env.DB,
    me
      ? `SELECT * FROM leagues
         WHERE visibility = 'public' OR creator_agent_id = ?
         ORDER BY created_at DESC`
      : `SELECT * FROM leagues WHERE visibility = 'public' ORDER BY created_at DESC`,
    ...(me ? [me.id] : []),
  );
  const leagues = [];
  for (const l of rows) {
    leagues.push(leagueJson(l, await leagueStats(env, l.id)));
  }
  return json({ leagues });
}

// GET /api/v1/leagues/:slug (public; invite_code only for the creator)
export async function getLeague(
  req: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const me = await optionalAgent(req, env);
  const league = await findLeague(env, slug);
  if (!league) {
    return err('league_not_found', 'League not found', 404);
  }
  if (league.visibility === 'private' && (!me || me.id !== league.creator_agent_id)) {
    return err('league_not_found', 'League not found', 404);
  }
  const isCreator = !!me && me.id === league.creator_agent_id;
  const seasons = await q<SeasonLiteRow>(
    env.DB,
    `SELECT id, name, pair, status, starts_at, ends_at, league_id, params
     FROM seasons WHERE league_id = ? ORDER BY starts_at DESC`,
    league.id,
  );
  const seasonsOut = [];
  for (const s of seasons) {
    const agents = await q1<{ n: number }>(
      env.DB,
      'SELECT COUNT(*) AS n FROM season_entries WHERE season_id = ?',
      s.id,
    );
    seasonsOut.push({ ...s, agent_count: agents?.n ?? 0, params: parseSeasonParams(s.params) });
  }
  return json({
    league: leagueJson(
      league,
      {
        is_creator: isCreator,
        // Invite codes are creator-only; joining agents get the code out-of-band.
        invite_code: isCreator ? league.invite_code : null,
        seasons: seasonsOut,
        ...(await leagueStats(env, league.id)),
      },
    ),
  });
}

// PATCH /api/v1/leagues/:slug (creator only; only before any season exists)
export async function updateLeague(
  req: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;
  const league = await findLeague(env, slug);
  if (!league) {
    return err('league_not_found', 'League not found', 404);
  }
  if (league.creator_agent_id !== auth.id) {
    return err('forbidden', 'Only the league creator can edit it', 403);
  }
  const seasonCount = await q1<{ n: number }>(
    env.DB,
    'SELECT COUNT(*) AS n FROM seasons WHERE league_id = ?',
    league.id,
  );
  if ((seasonCount?.n ?? 0) > 0) {
    return err(
      'season_started',
      'League params cannot change once a season exists',
      409,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err('bad_request', 'Request body must be JSON', 400);
  }
  let v;
  try {
    v = validateLeagueInput(body);
  } catch (e) {
    return err('invalid_league', (e as Error).message, 422);
  }

  await env.DB.prepare(
    `UPDATE leagues SET name = ?, description = ?, pairs = ?, season_days = ?,
       starting_capital = ?, max_leverage = ?, allow_short = ?, visibility = ?,
       invite_code = ?, max_agents = ? WHERE id = ?`,
  )
    .bind(
      v.name,
      v.description || null,
      JSON.stringify(v.params.pairs),
      v.params.season_days,
      v.params.starting_capital,
      v.params.max_leverage,
      v.params.allow_short ? 1 : 0,
      v.visibility,
      v.visibility === 'private' ? league.invite_code ?? newInviteCode() : null,
      v.max_agents,
      league.id,
    )
    .run();

  const updated = (await findLeague(env, slug)) as LeagueRow;
  return json({
    league: leagueJson(updated, {
      is_creator: true,
      invite_code: updated.invite_code,
      seasons: [],
      ...(await leagueStats(env, league.id)),
    }),
  });
}

// POST /api/v1/leagues/:slug/seasons (creator only)
// Body: {starts_at: <unix ms> | "now", name?: string}
export async function createLeagueSeason(
  req: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;
  const league = await findLeague(env, slug);
  if (!league) {
    return err('league_not_found', 'League not found', 404);
  }
  if (league.creator_agent_id !== auth.id) {
    return err('forbidden', 'Only the league creator can start seasons', 403);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err('bad_request', 'Request body must be JSON', 400);
  }
  const now = Date.now();
  let startsAt: number;
  if (body.starts_at === 'now' || body.starts_at === undefined) {
    startsAt = now;
  } else if (typeof body.starts_at === 'number' && Number.isFinite(body.starts_at)) {
    startsAt = Math.floor(body.starts_at);
  } else {
    return err('invalid_season', 'starts_at must be unix ms or "now"', 422);
  }
  if (startsAt < now - 60_000 || startsAt > now + 30 * 86_400_000) {
    return err(
      'invalid_season',
      'starts_at must be within the last minute to 30 days out',
      422,
    );
  }

  const pairs = JSON.parse(league.pairs) as string[];
  const seasonDays = league.season_days;
  const endsAt = startsAt + seasonDays * 86_400_000;
  const count = await q1<{ n: number }>(
    env.DB,
    'SELECT COUNT(*) AS n FROM seasons WHERE league_id = ?',
    league.id,
  );
  const name =
    typeof body.name === 'string' && body.name.trim().length > 0
      ? body.name.trim().slice(0, 128)
      : `${league.name} — Season ${(count?.n ?? 0) + 1}`;

  const params: SeasonParams = {
    pairs,
    season_days: seasonDays,
    starting_capital: league.starting_capital,
    max_leverage: league.max_leverage,
    allow_short: league.allow_short === 1,
  };

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO seasons
       (id, name, pair, starts_at, ends_at, status, market_type, created_at, league_id, params)
     VALUES (?, ?, ?, ?, ?, 'open', 'real', ?, ?, ?)`,
  )
    .bind(
      id,
      name,
      pairs[0],
      startsAt,
      endsAt,
      now,
      league.id,
      JSON.stringify(params),
    )
    .run();

  return json(
    {
      season: {
        id,
        name,
        pair: pairs[0],
        starts_at: startsAt,
        ends_at: endsAt,
        status: 'open',
        market_type: 'real',
        league_id: league.id,
        params,
      },
    },
    201,
  );
}

type LeagueSeasonAction = 'open' | 'close' | 'settle';

// POST /api/v1/leagues/:slug/seasons/:id/open|close|settle (creator only)
export async function leagueSeasonTransition(
  _req: Request,
  env: Env,
  slug: string,
  seasonId: string,
  action: LeagueSeasonAction,
): Promise<Response> {
  const auth = await requireAgent(_req, env);
  if (auth instanceof Response) return auth;
  const league = await findLeague(env, slug);
  if (!league) {
    return err('league_not_found', 'League not found', 404);
  }
  if (league.creator_agent_id !== auth.id) {
    return err('forbidden', 'Only the league creator can manage seasons', 403);
  }
  const season = await q1<SeasonLiteRow & { params: string | null }>(
    env.DB,
    'SELECT id, name, pair, status, starts_at, ends_at, league_id, params FROM seasons WHERE id = ?',
    seasonId,
  );
  if (!season || season.league_id !== league.id) {
    return err('season_not_found', 'Season not found in this league', 404);
  }
  const current = season.status;

  if (action === 'open') {
    if (current === 'settled') {
      return err('bad_transition', 'Settled seasons cannot be re-opened', 409);
    }
    const next = current === 'closed' ? 'open' : 'live';
    await run(env.DB, 'UPDATE seasons SET status = ? WHERE id = ?', next, seasonId);
    return json({ season: { ...season, params: parseSeasonParams(season.params), status: next } });
  }
  if (action === 'close') {
    if (current !== 'live' && current !== 'closed') {
      return err('bad_transition', `Cannot close a season in status '${current}'`, 409);
    }
    await run(env.DB, "UPDATE seasons SET status = 'closed' WHERE id = ?", seasonId);
    return json({ season: { ...season, params: parseSeasonParams(season.params), status: 'closed' } });
  }
  // settle: closed -> settled, computing final scores
  if (current !== 'closed' && current !== 'settled') {
    return err('bad_transition', `Cannot settle a season in status '${current}'`, 409);
  }
  if (current === 'settled') {
    return json({ season: { ...season, params: parseSeasonParams(season.params) } });
  }
  await settleSeason(env, seasonId);
  return json({
    season: { ...season, params: parseSeasonParams(season.params), status: 'settled' },
  });
}

// GET /api/v1/leagues/:slug/seasons/:id/leaderboard (public; season must belong to the league)
export async function leagueSeasonLeaderboard(
  _req: Request,
  env: Env,
  slug: string,
  seasonId: string,
): Promise<Response> {
  const league = await findLeague(env, slug);
  if (!league) {
    return err('league_not_found', 'League not found', 404);
  }
  const season = await q1<{ league_id: string | null }>(
    env.DB,
    'SELECT league_id FROM seasons WHERE id = ?',
    seasonId,
  );
  if (!season || season.league_id !== league.id) {
    return err('season_not_found', 'Season not found in this league', 404);
  }
  const entries = await leaderboardForSeason(env, seasonId);
  if (!entries) {
    return err('season_not_found', 'Season not found', 404);
  }
  return json({ league_slug: slug, season_id: seasonId, entries });
}

export { SUPPORTED_PAIRS };
