// The Pit — homepage human-first rebalance tests (mock D1, no network).
// Asserts: human-first hero + three paths, trimmed agent promo, SEO tags,
// /agents as the agent onboarding hub, and all machine surfaces intact.
import { describe, it, expect } from 'vitest';
import { homePage, agentsPage } from '../src/pages';
import { default as worker } from '../src/index';
import type { Env } from '../src/lib/types';

interface Handler {
  match: (sql: string) => boolean;
  all?: unknown[];
  first?: unknown;
}

function mockDb(handlers: Handler[]): Env {
  const db = {
    prepare(sql: string) {
      const h = handlers.find((x) => x.match(sql));
      const bound = () => ({
        all: async () => ({ results: h?.all ?? [] }),
        first: async () => h?.first ?? null,
        run: async () => ({ success: true }),
      });
      return {
        bind: bound,
        all: () => bound().all(),
        first: () => bound().first(),
        run: () => bound().run(),
      };
    },
  };
  return { DB: db, ADMIN_SECRET: 'x' } as unknown as Env;
}

const LIVE_SEASON = {
  id: 'season-1',
  name: 'Season One',
  pair: 'BTC/USD',
  starts_at: 1,
  ends_at: 2,
  status: 'live',
};

function pageHandlers(): Handler[] {
  return [
    { match: (s) => s.includes('LEFT JOIN scores'), all: [] },
    {
      match: (s) => s.includes("FROM seasons WHERE status = 'live'"),
      first: LIVE_SEASON,
    },
    { match: (s) => s.includes("status='scheduled'"), first: null },
    {
      match: (s) => s.includes('ORDER BY ts DESC LIMIT 1'),
      first: { bid: 81290, ask: 81292, ts: 1700000000000 },
    },
    {
      match: (s) => s.includes('MAX((bid+ask)/2.0)'),
      first: { hi: 83000, lo: 79000, n: 1440 },
    },
    {
      match: (s) => s.includes('ORDER BY ts ASC LIMIT 1'),
      first: { m: 80000 },
    },
    {
      match: (s) =>
        s.includes("FROM season_entries WHERE season_id = ? AND status = 'active'"),
      first: { n: 2 },
    },
    { match: (s) => s.includes('o.filled_at >='), first: { n: 42 } },
  ];
}

async function homeHtml(): Promise<string> {
  const res = await homePage(mockDb(pageHandlers()));
  expect(res.status).toBe(200);
  return res.text();
}

function agentsHtml(): Promise<string> {
  return agentsPage().text();
}

describe('homepage: human-first hero', () => {
  it('has exactly one h1 with plain-language hero copy', async () => {
    const html = await homeHtml();
    const h1s = html.match(/<h1\b/g) || [];
    expect(h1s.length).toBe(1);
    expect(html).toContain('Watch AI bots battle live crypto markets');
    expect(html).toContain('paper-trading competition');
    expect(html).toContain('$10,000 of virtual cash');
  });

  it('offers three intuitive paths: watch, play, compete', async () => {
    const html = await homeHtml();
    expect(html).toContain('Watch the battle live');
    expect(html).toContain('Test a strategy');
    expect(html).toContain('Run your own bot');
    expect(html).toContain('href="/leaderboard"');
    expect(html).toContain('href="/simulate"');
    expect(html).toContain('href="/agents"');
    expect(html).toContain('No account needed');
  });

  it('explains how The Pit works in plain language', async () => {
    const html = await homeHtml();
    expect(html).toContain('How The Pit works');
    expect(html).toContain('Bots enter a season');
    expect(html).toContain('Ranked on skill, not luck');
    expect(html).toContain('No real money');
  });

  it('trims agent marketing: no agent panel, no agent-banner CTAs', async () => {
    const html = await homeHtml();
    expect(html).not.toContain('Are you an agent?');
    expect(html).not.toContain('Agent? Read /llms.txt');
    expect(html).not.toContain('MCP-native');
    expect(html).not.toContain('16 tools, no REST wrangling');
    // One modest card + nav + modest panel + footer at most.
    const agentLinks = (html.match(/href="\/agents"/g) || []).length;
    expect(agentLinks).toBeLessThanOrEqual(5);
  });
});

describe('homepage: SEO', () => {
  it('has human-first title, meta description, OG tags, canonical', async () => {
    const html = await homeHtml();
    expect(html).toContain(
      '<title>Watch AI bots trade crypto live — The Pit</title>',
    );
    expect(html).toContain('name="description"');
    expect(html).toContain('paper-trading competition');
    expect(html).toContain('property="og:type" content="website"');
    expect(html).toContain('property="og:site_name" content="The Pit"');
    expect(html).toContain('property="og:title"');
    expect(html).toContain(
      '<link rel="canonical" href="https://pit.tannerwj.com/">',
    );
  });

  it('uses semantic headings: one h1, section h2s', async () => {
    const html = await homeHtml();
    expect(html).toContain('<h2 class="ph">How The Pit works</h2>');
    expect(html).toContain('<h2 class="ph">Live markets</h2>');
    expect(html).toContain('<h2 class="ph">Top bots');
  });
});

describe('nav + footer', () => {
  it('nav has a quiet For agents link instead of API Docs', async () => {
    const html = await homeHtml();
    expect(html).toContain('>For agents</a>');
    expect(html).toContain('href="/agents"');
    expect(html).not.toMatch(/<a href="\/llms\.txt">API/);
  });

  it('footer links the agent hub and the machine docs', async () => {
    const html = await homeHtml();
    expect(html).toContain('href="/agents"');
    expect(html).toContain('href="/llms.txt"');
    expect(html).toContain('href="/openapi.json"');
    expect(html).toContain('href="/.well-known/api-catalog"');
  });
});

describe('/agents: the agent onboarding hub', () => {
  it('has copy-paste quickstart: register, seasons, enter, order', async () => {
    const html = await agentsHtml();
    expect(html).toContain('Agent quickstart');
    expect(html).toContain('/api/v1/agents/register');
    expect(html).toContain('/api/v1/seasons');
    expect(html).toContain('place_order');
    expect(html).toContain('MCP');
    expect(html).toContain('/.well-known/mcp/server.json');
    expect(html).toContain('webhook');
  });

  it('documents rules, rate limits, and resources', async () => {
    const html = await agentsHtml();
    expect(html).toContain('Rules at a glance');
    expect(html).toContain('Rate limits');
    expect(html).toContain('/simulate');
    expect(html).toContain('/llms.txt');
    expect(html).toContain('/openapi.json');
    expect(html).toContain('SKILL.md');
    expect(html).toContain('examples');
  });

  it('uses the canonical domain in examples, no workers.dev', async () => {
    const html = await agentsHtml();
    expect(html).toContain('https://pit.tannerwj.com');
    expect(html).not.toContain('the-pit.twj.workers.dev');
  });
});

describe('machine surfaces still served', () => {
  const env = mockDb([]);
  const ctx = {} as never;

  it('serves /.well-known/mcp/server.json', async () => {
    const res = await worker.fetch(
      new Request('https://pit.tannerwj.com/.well-known/mcp/server.json'),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: unknown[] };
    expect(body.tools.length).toBeGreaterThan(0);
  });

  it('serves /llms.txt and /openapi.json', async () => {
    for (const p of ['/llms.txt', '/openapi.json']) {
      const res = await worker.fetch(
        new Request(`https://pit.tannerwj.com${p}`),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
    }
  });
});
