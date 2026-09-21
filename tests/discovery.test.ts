// The Pit — agent discovery wave tests (mock D1, no network).
// Covers: /.well-known/mcp/server.json payload shape + route mounting,
// /agents quickstart page mounting + key content, home agent panel link.
import { describe, it, expect } from 'vitest';
import { default as worker } from '../src/index';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_VERSION,
  MCP_TOOL_NAMES,
} from '../src/routes/mcp';
import { mcpServerJson } from '../src/docs';
import { agentsPage } from '../src/pages';
import type { Env } from '../src/lib/types';

function mockDb(): Env {
  const db = {
    prepare() {
      const bound = () => ({
        all: async () => ({ results: [] }),
        first: async () => null,
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

const env = mockDb();
const ctx = {} as never;
const ORIGIN = 'https://the-pit.twj.workers.dev';

describe('server.json payload', () => {
  it('returns 200 JSON with the registry schema shape', async () => {
    const res = mcpServerJson();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, any>;

    expect(body.name).toBe('The Pit');
    expect(body.version).toBe(MCP_SERVER_VERSION);
    expect(typeof body.description).toBe('string');
    expect(body.description.length).toBeGreaterThan(20);
    expect(body.repository).toBe('https://github.com/tannerwj/the-pit');
    expect(body.endpoint).toBe(`${ORIGIN}/mcp`);
    expect(body.transport).toEqual(['streamable-http']);
    expect(body.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(body.capabilities).toEqual({ tools: true, resources: false, prompts: false });

    // Auth story: machine-readable, unlike llms.txt.
    expect(body.auth).toBeTruthy();
    expect(typeof body.auth.scheme).toBe('string');
    expect(typeof body.auth.description).toBe('string');

    // Tools array mirrors the live MCP toolset — derived, not duplicated.
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.map((t: any) => t.name).sort()).toEqual(
      [...MCP_TOOL_NAMES].sort(),
    );
    expect(body.tools).toHaveLength(15);
    for (const t of body.tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(10);
    }

    // Onboarding pointers.
    expect(body.docs.quickstart).toBe(`${ORIGIN}/agents`);
    expect(String(body.docs.skill)).toContain('skills/the-pit/SKILL.md');
  });
});

describe('server.json route is mounted', () => {
  it('GET /.well-known/mcp/server.json -> 200 JSON', async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/.well-known/mcp/server.json`),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, any>;
    expect(body.name).toBe('The Pit');
    expect(body.endpoint).toBe(`${ORIGIN}/mcp`);
  });
});

describe('/agents quickstart page', () => {
  it('renders the onboarding page with copyable curl + MCP config + rules', async () => {
    const res = agentsPage();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Agent quickstart');
    expect(html).toContain('/api/v1/agents/register');
    expect(html).toContain('/api/v1/orders');
    expect(html).toContain('claude mcp add --transport http the-pit');
    expect(html).toContain('"mcpServers"');
    expect(html).toContain('rationale');
    expect(html).toContain('Alpha Score');
    expect(html).toContain('paper money');
    expect(html).toContain('data-copy'); // copy buttons, no reload
    expect(html).toContain('skills/the-pit/SKILL.md');
  });

  it('is mounted on the worker router', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/agents`), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

describe('home page agent panel', () => {
  it('links /agents from the agent CTA', async () => {
    const res = await worker.fetch(new Request(ORIGIN + '/'), env, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/agents"');
  });
});
