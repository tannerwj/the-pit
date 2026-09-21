// The Pit wave 3 — fantasy league tests (mock D1, no network).
import { describe, it, expect } from 'vitest';
import {
  validateLeagueInput,
  parseSeasonParams,
  slugify,
  SUPPORTED_PAIRS,
  DEFAULT_SEASON_PARAMS,
} from '../src/lib/leagues';
import { checkLeverage, shouldLiquidate } from '../src/lib/engine';
import {
  createLeague,
  listLeagues,
  getLeague,
  updateLeague,
  createLeagueSeason,
  leagueSeasonTransition,
  leagueSeasonLeaderboard,
} from '../src/routes/leagues';
import { enterSeason } from '../src/routes/seasons';
import { placeOrder } from '../src/routes/orders';
import type { Env } from '../src/lib/types';

type Handler = {
  match: (sql: string) => boolean;
  all?: unknown[] | ((params: unknown[]) => unknown[]);
  first?: unknown | ((params: unknown[]) => unknown);
  onRun?: (sql: string, params: unknown[]) => void;
};

function mockDb(handlers: Handler[]): Env {
  const find = (sql: string) =>
    handlers.find((x) => x.match(sql)) ?? {
      match: () => true,
      all: [],
      first: null,
    };
  const db = {
    prepare(sql: string) {
      const h = find(sql);
      const bound = (...p: unknown[]) => ({
        all: async () => ({
          results:
            typeof h.all === 'function' ? (h.all as (x: unknown[]) => unknown[])(p) : (h.all ?? []),
        }),
        first: async () =>
          typeof h.first === 'function' ? (h.first as (x: unknown[]) => unknown)(p) : (h.first ?? null),
        run: async () => {
          h.onRun?.(sql, p);
          return { success: true };
        },
      });
      return { bind: bound, batch: async () => [] as unknown[] };
    },
    batch: async () => [] as unknown[],
  };
  return { DB: db, ADMIN_SECRET: 'x' } as unknown as Env;
}

const AGENT = { id: 'agent-1', email: 'a@x.com', name: 'A1', status: 'active' };
const AGENT2 = { id: 'agent-2', email: 'b@x.com', name: 'B2', status: 'active' };

function agentHandlers(agent: typeof AGENT = AGENT): Handler[] {
  return [
    {
      match: (s) => s.includes('FROM agents WHERE api_key_hash'),
      first: agent,
    },
  ];
}

function req(
  url: string,
  opts: { method?: string; key?: string | null; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.key !== null) headers['X-API-Key'] = opts.key ?? 'test-key';
  return new Request(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

async function jsonBody(res: Response) {
  return (await res.json()) as Record<string, any>;
}

interface LeagueFixture {
  id: string;
  slug: string;
  name: string;
  description: string;
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

const PUBLIC_LEAGUE: LeagueFixture = {
  id: 'L1',
  slug: 'test-league',
  name: 'Test League',
  description: 'desc',
  creator_agent_id: 'agent-1',
  pairs: JSON.stringify(['BTC/USD', 'ETH/USD']),
  season_days: 7,
  starting_capital: 5000,
  max_leverage: 2,
  allow_short: 1,
  visibility: 'public',
  invite_code: null,
  max_agents: 10,
  created_at: 1700000000000,
};

const PRIVATE_LEAGUE: LeagueFixture = {
  ...PUBLIC_LEAGUE,
  id: 'L2',
  slug: 'secret-league',
  visibility: 'private',
  invite_code: 'secret1',
};

const DEFAULT_PARAMS_JSON = JSON.stringify({
  pairs: [...SUPPORTED_PAIRS],
  season_days: 14,
  starting_capital: 10000,
  max_leverage: 3,
  allow_short: true,
});

function leagueLookupHandlers(league: typeof PUBLIC_LEAGUE | null): Handler[] {
  return [
    {
      match: (s) => s.includes('FROM leagues WHERE slug = ?'),
      first: league,
    },
  ];
}

describe('league param validation (pure)', () => {
  const valid = {
    name: 'My League',
    pairs: ['BTC/USD', 'ETH/USD'],
    season_days: 7,
    starting_capital: 5000,
    max_leverage: 2,
    allow_short: false,
    visibility: 'private',
    max_agents: 16,
  };

  it('accepts a full valid config', () => {
    const v = validateLeagueInput(valid);
    expect(v.params.pairs).toEqual(['BTC/USD', 'ETH/USD']);
    expect(v.params.season_days).toBe(7);
    expect(v.params.starting_capital).toBe(5000);
    expect(v.params.max_leverage).toBe(2);
    expect(v.params.allow_short).toBe(false);
    expect(v.visibility).toBe('private');
    expect(v.max_agents).toBe(16);
  });

  it('defaults pairs to all supported when omitted', () => {
    const v = validateLeagueInput({ ...valid, pairs: undefined });
    expect(v.params.pairs).toEqual([...SUPPORTED_PAIRS]);
  });

  it('rejects unknown pairs', () => {
    expect(() => validateLeagueInput({ ...valid, pairs: ['FAKE/USD'] })).toThrow(
      /pairs must be/,
    );
  });

  it('rejects empty pairs', () => {
    expect(() => validateLeagueInput({ ...valid, pairs: [] })).toThrow(/pairs must be/);
  });

  it('rejects out-of-range season_days / capital / leverage / agents / visibility', () => {
    expect(() => validateLeagueInput({ ...valid, season_days: 0 })).toThrow(/season_days/);
    expect(() => validateLeagueInput({ ...valid, season_days: 31 })).toThrow(/season_days/);
    expect(() => validateLeagueInput({ ...valid, season_days: 1.5 })).toThrow(/season_days/);
    expect(() => validateLeagueInput({ ...valid, starting_capital: 999 })).toThrow(/starting_capital/);
    expect(() => validateLeagueInput({ ...valid, starting_capital: 100001 })).toThrow(/starting_capital/);
    expect(() => validateLeagueInput({ ...valid, max_leverage: 0.5 })).toThrow(/max_leverage/);
    expect(() => validateLeagueInput({ ...valid, max_leverage: 4 })).toThrow(/max_leverage/);
    expect(() => validateLeagueInput({ ...valid, visibility: 'secret' })).toThrow(/visibility/);
    expect(() => validateLeagueInput({ ...valid, max_agents: 1 })).toThrow();
    expect(() => validateLeagueInput({ ...valid, name: '' })).toThrow(/name/);
  });

  it('parseSeasonParams falls back to official defaults on junk', () => {
    expect(parseSeasonParams(null)).toEqual(DEFAULT_SEASON_PARAMS);
    expect(parseSeasonParams('not json')).toEqual(DEFAULT_SEASON_PARAMS);
    const p = parseSeasonParams(JSON.stringify({ pairs: ['ETH/USD'], max_leverage: 1 }));
    expect(p.pairs).toEqual(['ETH/USD']);
    expect(p.max_leverage).toBe(1);
    expect(p.season_days).toBe(DEFAULT_SEASON_PARAMS.season_days);
    expect(p.allow_short).toBe(true);
    // unknown pairs are filtered; empty list falls back to all
    expect(parseSeasonParams(JSON.stringify({ pairs: ['NOPE/USD'] })).pairs).toEqual([
      ...SUPPORTED_PAIRS,
    ]);
  });

  it('slugify makes URL-safe slugs', () => {
    expect(slugify("Tanner's Turbo League!")).toBe('tanner-s-turbo-league');
    expect(slugify('!!!')).toBe('league');
  });
});

describe('POST /api/v1/leagues', () => {
  const body = {
    name: 'Test League',
    pairs: ['BTC/USD', 'ETH/USD'],
    season_days: 7,
    starting_capital: 5000,
    max_leverage: 2,
    allow_short: false,
    visibility: 'public',
    max_agents: 10,
  };

  it('creates a public league with slug and no invite code', async () => {
    const seen: unknown[][] = [];
    const env = mockDb([
      ...agentHandlers(),
      { match: (s) => s.includes('SELECT id FROM leagues WHERE slug = ?'), first: null },
      {
        match: (s) => s.includes('INSERT INTO leagues'),
        onRun: (_s, p) => seen.push(p),
      },
    ]);
    const res = await createLeague(req('https://x/api/v1/leagues', { method: 'POST', body }), env);
    expect(res.status).toBe(201);
    const j = await jsonBody(res);
    expect(j.league.slug).toBe('test-league');
    expect(j.league.invite_code).toBeNull();
    expect(j.league.pairs).toEqual(['BTC/USD', 'ETH/USD']);
    expect(j.league.max_leverage).toBe(2);
    expect(j.league.allow_short).toBe(false);
    expect(j.warning).toBeUndefined();
    expect(seen.length).toBe(1);
  });

  it('creates a private league with an invite code shown once', async () => {
    const env = mockDb([
      ...agentHandlers(),
      { match: (s) => s.includes('SELECT id FROM leagues WHERE slug = ?'), first: null },
    ]);
    const res = await createLeague(
      req('https://x/api/v1/leagues', {
        method: 'POST',
        body: { ...body, visibility: 'private', name: 'Secret Club' },
      }),
      env,
    );
    expect(res.status).toBe(201);
    const j = await jsonBody(res);
    expect(j.league.slug).toBe('secret-club');
    expect(typeof j.league.invite_code).toBe('string');
    expect(j.league.invite_code.length).toBeGreaterThan(4);
    expect(j.warning).toMatch(/invite_code/);
  });

  it('deduplicates slugs on collision', async () => {
    const env = mockDb([
      ...agentHandlers(),
      {
        match: (s) => s.includes('SELECT id FROM leagues WHERE slug = ?'),
        first: (p: unknown[]) => (p[0] === 'test-league' ? { id: 'other' } : null),
      },
    ]);
    const res = await createLeague(req('https://x/api/v1/leagues', { method: 'POST', body }), env);
    expect((await jsonBody(res)).league.slug).toBe('test-league-2');
  });

  it('rejects invalid params with 422 and requires auth', async () => {
    const env = mockDb(agentHandlers());
    const bad = await createLeague(
      req('https://x/api/v1/leagues', { method: 'POST', body: { ...body, season_days: 99 } }),
      env,
    );
    expect(bad.status).toBe(422);
    expect((await jsonBody(bad)).error.code).toBe('invalid_league');
    const noAuth = await createLeague(
      req('https://x/api/v1/leagues', { method: 'POST', body, key: null }),
      env,
    );
    expect(noAuth.status).toBe(401);
  });
});

describe('GET /api/v1/leagues', () => {
  it('anonymous sees only public leagues', async () => {
    const env = mockDb([
      {
        match: (s) => s.includes('FROM leagues') && !s.includes('creator_agent_id'),
        all: [PUBLIC_LEAGUE],
      },
    ]);
    const res = await listLeagues(req('https://x/api/v1/leagues', { key: null }), env);
    expect(res.status).toBe(200);
    const j = await jsonBody(res);
    expect(j.leagues.length).toBe(1);
    expect(j.leagues[0].slug).toBe('test-league');
    expect('invite_code' in j.leagues[0]).toBe(false);
  });

  it('creator also sees their own private leagues', async () => {
    const env = mockDb([
      ...agentHandlers(),
      {
        match: (s) => s.includes('FROM leagues') && s.includes('OR creator_agent_id'),
        all: [PUBLIC_LEAGUE, PRIVATE_LEAGUE],
      },
    ]);
    const res = await listLeagues(req('https://x/api/v1/leagues'), env);
    const j = await jsonBody(res);
    expect(j.leagues.length).toBe(2);
  });
});

describe('GET /api/v1/leagues/:slug', () => {
  const seasonRows = [
    { id: 's1', name: 'S1', pair: 'BTC/USD', status: 'live', starts_at: 1, ends_at: 2, league_id: 'L2' },
  ];
  function handlers(league: typeof PUBLIC_LEAGUE | null, agent: typeof AGENT = AGENT): Handler[] {
    return [
      ...agentHandlers(agent),
      ...leagueLookupHandlers(league),
      { match: (s) => s.includes('FROM seasons WHERE league_id = ?'), all: seasonRows },
      { match: (s) => s.includes('FROM season_entries WHERE season_id = ?'), first: { n: 3 } },
    ];
  }

  it('hides private leagues from strangers (404)', async () => {
    const env = mockDb(handlers(PRIVATE_LEAGUE, AGENT2));
    const res = await getLeague(req('https://x/api/v1/leagues/secret-league'), env, 'secret-league');
    expect(res.status).toBe(404);
    const envAnon = mockDb(handlers(PRIVATE_LEAGUE));
    const resAnon = await getLeague(
      req('https://x/api/v1/leagues/secret-league', { key: null }),
      envAnon,
      'secret-league',
    );
    expect(resAnon.status).toBe(404);
  });

  it('shows invite_code only to the creator', async () => {
    const env = mockDb(handlers(PRIVATE_LEAGUE));
    const res = await getLeague(req('https://x/api/v1/leagues/secret-league'), env, 'secret-league');
    expect(res.status).toBe(200);
    const j = await jsonBody(res);
    expect(j.league.invite_code).toBe('secret1');
    expect(j.league.is_creator).toBe(true);
    expect(j.league.seasons.length).toBe(1);
    expect(j.league.seasons[0].agent_count).toBe(3);
  });

  it('public league detail works anonymously without invite code', async () => {
    const env = mockDb(handlers(PUBLIC_LEAGUE));
    const res = await getLeague(
      req('https://x/api/v1/leagues/test-league', { key: null }),
      env,
      'test-league',
    );
    expect(res.status).toBe(200);
    const j = await jsonBody(res);
    expect(j.league.invite_code).toBeNull();
    expect(j.league.is_creator).toBe(false);
  });
});

describe('PATCH /api/v1/leagues/:slug', () => {
  const patchBody = {
    name: 'Renamed',
    pairs: ['SOL/USD'],
    season_days: 3,
    starting_capital: 2000,
    max_leverage: 1,
    allow_short: true,
    visibility: 'public',
    max_agents: 5,
  };
  function handlers(league: typeof PUBLIC_LEAGUE, seasonCount: number, agent: typeof AGENT = AGENT): Handler[] {
    return [
      ...agentHandlers(agent),
      { match: (s) => s.includes('SELECT * FROM leagues WHERE slug = ?'), first: league },
      { match: (s) => s.includes('SELECT COUNT(*) AS n FROM seasons WHERE league_id = ?'), first: { n: seasonCount } },
    ];
  }

  it('forbids non-creators', async () => {
    const env = mockDb(handlers(PUBLIC_LEAGUE, 0, AGENT2));
    const res = await updateLeague(
      req('https://x/api/v1/leagues/test-league', { method: 'PATCH', body: patchBody }),
      env,
      'test-league',
    );
    expect(res.status).toBe(403);
  });

  it('refuses edits once a season exists', async () => {
    const env = mockDb(handlers(PUBLIC_LEAGUE, 1));
    const res = await updateLeague(
      req('https://x/api/v1/leagues/test-league', { method: 'PATCH', body: patchBody }),
      env,
      'test-league',
    );
    expect(res.status).toBe(409);
    expect((await jsonBody(res)).error.code).toBe('season_started');
  });

  it('applies edits before any season exists', async () => {
    const seen: unknown[][] = [];
    const env = mockDb([
      ...handlers(PUBLIC_LEAGUE, 0),
      {
        match: (s) => s.includes('UPDATE leagues SET'),
        onRun: (_s, p) => seen.push(p),
      },
    ]);
    const res = await updateLeague(
      req('https://x/api/v1/leagues/test-league', { method: 'PATCH', body: patchBody }),
      env,
      'test-league',
    );
    expect(res.status).toBe(200);
    // The mock re-read returns the stale row, so assert on the UPDATE bind params:
    // [name, description, pairs, season_days, starting_capital, max_leverage, allow_short, visibility, invite_code, max_agents, id]
    expect(seen.length).toBe(1);
    const p = seen[0];
    expect(p[0]).toBe('Renamed');
    expect(p[2]).toBe(JSON.stringify(['SOL/USD']));
    expect(p[3]).toBe(3);
    expect(p[4]).toBe(2000);
    expect(p[5]).toBe(1);
    expect(p[6]).toBe(1);
    expect(p[9]).toBe(5);
  });
});

describe('POST /api/v1/leagues/:slug/seasons', () => {
  function handlers(league: typeof PUBLIC_LEAGUE, agent: typeof AGENT = AGENT): Handler[] {
    return [
      ...agentHandlers(agent),
      ...leagueLookupHandlers(league),
      { match: (s) => s.includes('SELECT COUNT(*) AS n FROM seasons WHERE league_id = ?'), first: { n: 2 } },
    ];
  }

  it('forbids non-creators', async () => {
    const env = mockDb(handlers(PUBLIC_LEAGUE, AGENT2));
    const res = await createLeagueSeason(
      req('https://x/api/v1/leagues/test-league/seasons', { method: 'POST', body: { starts_at: 'now' } }),
      env,
      'test-league',
    );
    expect(res.status).toBe(403);
  });

  it('creates a season with params snapshot and days-based window', async () => {
    const before = Date.now();
    const env = mockDb(handlers(PUBLIC_LEAGUE));
    const res = await createLeagueSeason(
      req('https://x/api/v1/leagues/test-league/seasons', { method: 'POST', body: { starts_at: 'now' } }),
      env,
      'test-league',
    );
    expect(res.status).toBe(201);
    const j = await jsonBody(res);
    expect(j.season.status).toBe('open');
    expect(j.season.league_id).toBe('L1');
    expect(j.season.pair).toBe('BTC/USD');
    expect(j.season.name).toContain('Season 3');
    expect(j.season.starts_at).toBeGreaterThanOrEqual(before);
    expect(j.season.ends_at - j.season.starts_at).toBe(7 * 86_400_000);
    expect(j.season.params.pairs).toEqual(['BTC/USD', 'ETH/USD']);
    expect(j.season.params.starting_capital).toBe(5000);
    expect(j.season.params.max_leverage).toBe(2);
    expect(j.season.params.allow_short).toBe(true);
  });

  it('rejects absurd starts_at', async () => {
    const env = mockDb(handlers(PUBLIC_LEAGUE));
    const res = await createLeagueSeason(
      req('https://x/api/v1/leagues/test-league/seasons', {
        method: 'POST',
        body: { starts_at: Date.now() - 3_600_000 },
      }),
      env,
      'test-league',
    );
    expect(res.status).toBe(422);
  });
});

describe('league season lifecycle (creator-gated)', () => {
  const seasonRow = {
    id: 's1',
    name: 'S1',
    pair: 'BTC/USD',
    status: 'open',
    starts_at: 1,
    ends_at: 2,
    league_id: 'L1',
    params: null,
  };
  function handlers(agent: typeof AGENT = AGENT): Handler[] {
    return [
      ...agentHandlers(agent),
      ...leagueLookupHandlers(PUBLIC_LEAGUE),
      { match: (s) => s.includes('FROM seasons WHERE id = ?'), first: seasonRow },
    ];
  }

  it('non-creator cannot open a season', async () => {
    const env = mockDb(handlers(AGENT2));
    const res = await leagueSeasonTransition(
      req('https://x/api/v1/leagues/test-league/seasons/s1/open', { method: 'POST' }),
      env,
      'test-league',
      's1',
      'open',
    );
    expect(res.status).toBe(403);
  });

  it('creator opens an open season to live', async () => {
    const env = mockDb(handlers());
    const res = await leagueSeasonTransition(
      req('https://x/api/v1/leagues/test-league/seasons/s1/open', { method: 'POST' }),
      env,
      'test-league',
      's1',
      'open',
    );
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).season.status).toBe('live');
  });

  it('rejects a season from another league', async () => {
    const env = mockDb([
      ...agentHandlers(),
      ...leagueLookupHandlers(PUBLIC_LEAGUE),
      { match: (s) => s.includes('FROM seasons WHERE id = ?'), first: { ...seasonRow, league_id: 'OTHER' } },
    ]);
    const res = await leagueSeasonTransition(
      req('https://x/api/v1/leagues/test-league/seasons/s1/open', { method: 'POST' }),
      env,
      'test-league',
      's1',
      'open',
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/leagues/:slug/seasons/:id/leaderboard', () => {
  const lbRows = [
    {
      agent_name: 'A1',
      cash: 5000,
      alpha_score: 60,
      total_return: 0.1,
      sharpe: 1,
      max_drawdown: 0.05,
      win_rate: 0.6,
      profit_factor: 1.4,
      trades: 5,
      equity: 5500,
    },
  ];
  function handlers(seasonLeagueId: string): Handler[] {
    return [
      ...leagueLookupHandlers(PUBLIC_LEAGUE),
      { match: (s) => s.includes('SELECT league_id FROM seasons WHERE id = ?'), first: { league_id: seasonLeagueId } },
      { match: (s) => s.includes('SELECT id FROM seasons WHERE id = ?'), first: { id: 's1' } },
      { match: (s) => s.includes('LEFT JOIN scores'), all: lbRows },
    ];
  }

  it('serves the season leaderboard for a league season', async () => {
    const env = mockDb(handlers('L1'));
    const res = await leagueSeasonLeaderboard(
      req('https://x/api/v1/leagues/test-league/seasons/s1/leaderboard'),
      env,
      'test-league',
      's1',
    );
    expect(res.status).toBe(200);
    const j = await jsonBody(res);
    expect(j.league_slug).toBe('test-league');
    expect(j.entries.length).toBe(1);
    expect(j.entries[0].equity).toBe(5500);
  });

  it('404s when the season belongs to another league', async () => {
    const env = mockDb(handlers('OTHER'));
    const res = await leagueSeasonLeaderboard(
      req('https://x/api/v1/leagues/test-league/seasons/s1/leaderboard'),
      env,
      'test-league',
      's1',
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/seasons/:id/enter with leagues', () => {
  function handlers(opts: {
    league?: typeof PUBLIC_LEAGUE | null;
    leagueId?: string | null;
    entryCount?: number;
    existing?: unknown;
    capital?: number;
  }): Handler[] {
    const leagueRow = opts.league
      ? {
          visibility: opts.league.visibility,
          invite_code: opts.league.invite_code,
          max_agents: opts.league.max_agents,
        }
      : null;
    return [
      ...agentHandlers(),
      {
        match: (s) => s.includes('FROM seasons WHERE id = ?'),
        first: {
          id: 's1',
          name: 'S1',
          pair: 'BTC/USD',
          starts_at: 1,
          ends_at: 2,
          status: 'open',
          market_type: 'real',
          league_id: opts.leagueId ?? null,
          params: JSON.stringify({
            pairs: [...SUPPORTED_PAIRS],
            season_days: 14,
            starting_capital: opts.capital ?? 10000,
            max_leverage: 3,
            allow_short: true,
          }),
        },
      },
      {
        match: (s) => s.includes('FROM season_entries WHERE season_id = ? AND agent_id = ?'),
        first: opts.existing ?? null,
      },
      { match: (s) => s.includes('FROM leagues WHERE id = ?'), first: leagueRow },
      {
        match: (s) => s.includes('FROM season_entries WHERE season_id = ?'),
        first: { n: opts.entryCount ?? 0 },
      },
    ];
  }
  const enter = (env: Env, body?: unknown) =>
    enterSeason(req('https://x/api/v1/seasons/s1/enter', { method: 'POST', body }), env, 's1');

  it('official seasons need no code and use season capital', async () => {
    const env = mockDb(handlers({ leagueId: null, capital: 25000 }));
    const res = await enter(env);
    expect(res.status).toBe(201);
    const j = await jsonBody(res);
    expect(j.entry.starting_capital).toBe(25000);
    expect(j.entry.cash).toBe(25000);
  });

  it('private league season rejects missing/wrong invite code', async () => {
    const env = mockDb(handlers({ league: PRIVATE_LEAGUE, leagueId: 'L2' }));
    const missing = await enter(env);
    expect(missing.status).toBe(403);
    expect((await jsonBody(missing)).error.code).toBe('invite_required');
    const wrong = await enter(env, { invite_code: 'nope' });
    expect(wrong.status).toBe(403);
  });

  it('private league season accepts the right code', async () => {
    const env = mockDb(handlers({ league: PRIVATE_LEAGUE, leagueId: 'L2' }));
    const res = await enter(env, { invite_code: 'secret1' });
    expect(res.status).toBe(201);
  });

  it('enforces max_agents', async () => {
    const env = mockDb(handlers({ league: PUBLIC_LEAGUE, leagueId: 'L1', entryCount: 10 }));
    const res = await enter(env);
    expect(res.status).toBe(409);
    expect((await jsonBody(res)).error.code).toBe('league_full');
  });

  it('public league season needs no code', async () => {
    const env = mockDb(handlers({ league: PUBLIC_LEAGUE, leagueId: 'L1', entryCount: 3 }));
    const res = await enter(env);
    expect(res.status).toBe(201);
  });
});

describe('POST /api/v1/orders with season params', () => {
  const seasonParams = {
    pairs: [...SUPPORTED_PAIRS],
    season_days: 14,
    starting_capital: 10000,
    max_leverage: 3,
    allow_short: true,
  };
  function handlers(opts: {
    params?: typeof seasonParams;
    entry?: unknown;
    position?: unknown;
    quote?: unknown;
  }): Handler[] {
    return [
      ...agentHandlers(),
      {
        match: (s) => s.includes('FROM seasons WHERE id = ?'),
        first: {
          id: 's1',
          pair: 'BTC/USD',
          status: 'live',
          params: JSON.stringify(opts.params ?? seasonParams),
        },
      },
      {
        match: (s) => s.includes('FROM season_entries WHERE season_id = ? AND agent_id = ?'),
        first: opts.entry ?? {
          id: 'e1',
          season_id: 's1',
          agent_id: 'agent-1',
          cash: 10000,
          status: 'active',
          starting_capital: 10000,
        },
      },
      {
        match: (s) => s.includes('FROM positions WHERE entry_id = ? AND pair = ?'),
        first: opts.position ?? { qty: 0, avg_price: 0 },
      },
      {
        match: (s) => s.includes('FROM quotes WHERE pair = ? ORDER BY ts DESC LIMIT 1'),
        first: opts.quote ?? null,
      },
    ];
  }
  const order = (env: Env, body: unknown) =>
    placeOrder(req('https://x/api/v1/orders', { method: 'POST', body }), env);
  const base = {
    season_id: 's1',
    side: 'buy',
    qty: 0.01,
    type: 'market',
    rationale: 'testing the pair guard',
  };

  it('rejects pairs outside the season pair list', async () => {
    const env = mockDb(
      handlers({ params: { ...seasonParams, pairs: ['ETH/USD'] } }),
    );
    const res = await order(env, { ...base, pair: 'BTC/USD' });
    expect(res.status).toBe(422);
    const j = await jsonBody(res);
    expect(j.error.code).toBe('bad_pair');
    expect(j.error.message).toContain('ETH/USD');
  });

  it('accepts any supported pair in a multi-pair season', async () => {
    const env = mockDb(
      handlers({
        quote: { bid: 2999, ask: 3001, ts: Date.now(), source: 'coinbase' },
      }),
    );
    const res = await order(env, { ...base, pair: 'ETH/USD' });
    expect(res.status).toBe(201);
    expect((await jsonBody(res)).order.pair).toBe('ETH/USD');
  });

  it('rejects shorts when the season disallows them', async () => {
    const env = mockDb(
      handlers({ params: { ...seasonParams, allow_short: false } }),
    );
    const res = await order(env, { ...base, pair: 'BTC/USD', side: 'sell', qty: 1 });
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).error.code).toBe('shorts_disallowed');
  });

  it('allows sells that only close a long when shorts are disallowed', async () => {
    const env = mockDb(
      handlers({
        params: { ...seasonParams, allow_short: false },
        position: { qty: 1, avg_price: 80000 },
        quote: { bid: 79999, ask: 80001, ts: Date.now(), source: 'coinbase' },
      }),
    );
    const res = await order(env, { ...base, pair: 'BTC/USD', side: 'sell', qty: 0.5 });
    expect(res.status).toBe(201);
  });

  it('enforces the season max_leverage (1x league)', async () => {
    const env = mockDb(
      handlers({
        params: { ...seasonParams, max_leverage: 1 },
        quote: { bid: 80000, ask: 80000, ts: Date.now(), source: 'coinbase' },
      }),
    );
    // 0.25 BTC @ $80k = $20k notional on $10k equity = 2x > 1x cap
    const res = await order(env, { ...base, pair: 'BTC/USD', qty: 0.25 });
    expect(res.status).toBe(422);
    const j = await jsonBody(res);
    expect(j.error.code).toBe('leverage_exceeded');
    expect(j.error.message).toContain('1x');
  });

  it('still allows 2x in a 3x season', async () => {
    const env = mockDb(
      handlers({
        quote: { bid: 80000, ask: 80000, ts: Date.now(), source: 'coinbase' },
      }),
    );
    const res = await order(env, { ...base, pair: 'BTC/USD', qty: 0.25 });
    expect(res.status).toBe(201);
  });
});

describe('engine param-driven guards', () => {
  it('checkLeverage honors a custom maxLeverage', () => {
    const args = { cash: 10000, posQty: 0, side: 'buy' as const, orderQty: 0.25, fillPrice: 80000 };
    expect(checkLeverage({ ...args, maxLeverage: 1 }).ok).toBe(false);
    expect(checkLeverage({ ...args, maxLeverage: 1 }).reason).toContain('1x');
    expect(checkLeverage({ ...args, maxLeverage: 3 }).ok).toBe(true);
    expect(checkLeverage(args).ok).toBe(true); // default 3x allows 2x
  });

  it('liquidation threshold follows the season starting capital', () => {
    expect(shouldLiquidate(2000, 10000)).toBe(true);
    expect(shouldLiquidate(2001, 10000)).toBe(false);
    // a $2k-capital league season liquidates at $400, not $2000
    expect(shouldLiquidate(400, 2000)).toBe(true);
    expect(shouldLiquidate(401, 2000)).toBe(false);
    expect(shouldLiquidate(1500, 2000)).toBe(false);
  });
});
