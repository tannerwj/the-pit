import { describe, expect, test } from 'e2e';
import {
  localCtx,
  post,
  lapi,
  errCode,
  RATIONALE,
} from './support/local.js';

// Fantasy-league write flows against LOCAL wrangler dev — never production:
// league creation, creator-only guards, league season lifecycle, and trading
// inside a league season.
describe('fantasy leagues (local)', { platforms: ['local'], tags: ['api', 'write'] }, () => {
  test('create league -> 201 with slug; invalid body -> 422 invalid_league', async () => {
    const c = localCtx();
    const res = await post(
      '/api/v1/leagues',
      {
        name: `E2E League ${Date.now()}`,
        description: 'e2e test league',
        pairs: ['BTC/USD'],
        season_days: 7,
        starting_capital: 10000,
        max_leverage: 3,
        allow_short: true,
        visibility: 'public',
        max_agents: 10,
      },
      c.agent,
    );
    expect(res.status).toBe(201);
    const { league } = (await res.json()) as {
      league: { slug: string; name: string; status: string; is_creator: boolean };
    };
    expect(league.slug.length).toBeGreaterThan(0);
    expect(league.is_creator).toBe(true);

    const bad = await post(
      '/api/v1/leagues',
      {
        name: '', // invalid: 1-80 chars
        season_days: 7,
        starting_capital: 10000,
        max_leverage: 3,
        max_agents: 10,
      },
      c.agent,
    );
    expect(bad.status).toBe(422);
    expect(await errCode(bad)).toBe('invalid_league');
  });

  test('non-creator cannot edit a league -> 403 forbidden', async () => {
    const c = localCtx();
    const created = await post(
      '/api/v1/leagues',
      {
        name: `E2E Guard ${Date.now()}`,
        season_days: 7,
        starting_capital: 10000,
        max_leverage: 3,
        max_agents: 10,
      },
      c.agent,
    );
    const { league } = (await created.json()) as { league: { slug: string } };
    const res = await lapi(`/api/v1/leagues/${league.slug}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...c.otherAgent },
      body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe('forbidden');
  });

  test('league season lifecycle: create -> open -> enter -> trade', async () => {
    const c = localCtx();
    const created = await post(
      '/api/v1/leagues',
      {
        name: `E2E Season ${Date.now()}`,
        pairs: ['BTC/USD'],
        season_days: 7,
        starting_capital: 10000,
        max_leverage: 3,
        allow_short: true,
        visibility: 'public',
        max_agents: 10,
      },
      c.agent,
    );
    expect(created.status).toBe(201);
    const { league } = (await created.json()) as { league: { slug: string } };

    // League season starts `open`; the open transition flips it live.
    const season = await post(
      `/api/v1/leagues/${league.slug}/seasons`,
      { name: 'E2E League Season', starts_at: 'now' },
      c.agent,
    );
    expect(season.status).toBe(201);
    const { season: s } = (await season.json()) as {
      season: { id: string; status: string; league_id: string };
    };
    expect(s.status).toBe('open');

    const opened = await post(
      `/api/v1/leagues/${league.slug}/seasons/${s.id}/open`,
      {},
      c.agent,
    );
    expect(opened.status).toBe(200);

    // A fresh agent enters the league season and trades.
    const { headers } = await (async () => {
      const name = `lg-${Date.now()}`;
      const reg = await post('/api/v1/agents/register', {
        email: `${name}@local.test`,
        name,
      });
      const { api_key } = (await reg.json()) as { api_key: string };
      const h = { 'X-API-Key': api_key };
      const enter = await post(`/api/v1/seasons/${s.id}/enter`, {}, h);
      expect(enter.status).toBe(201);
      return { headers: h };
    })();

    const order = await post(
      '/api/v1/orders',
      {
        season_id: s.id,
        pair: 'BTC/USD',
        side: 'buy',
        qty: 0.01,
        type: 'limit',
        limit_price: 1000, // rests open; no quote needed
        rationale: RATIONALE,
      },
      headers,
    );
    expect(order.status).toBe(201);

    // League-scoped leaderboard includes the entry.
    const lb = await lapi(
      `/api/v1/leagues/${league.slug}/seasons/${s.id}/leaderboard`,
    );
    expect(lb.status).toBe(200);
    const body = (await lb.json()) as { entries: unknown[] };
    expect(body.entries.length).toBe(1);
  });
});
