// The Pit — MCP server tests (mock D1, no network).
// Covers: initialize handshake shape, tools/list contents, tools/call dispatch,
// auth rejection, place_order validation parity with REST, JSON-RPC errors,
// notifications, CORS/OPTIONS.
import { describe, it, expect } from 'vitest';
import { handleMcp, MCP_PROTOCOL_VERSION, MCP_TOOL_NAMES } from '../src/routes/mcp';
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
      const unbound = bound();
      return { bind: bound, batch: async () => [] as unknown[], all: unbound.all, first: unbound.first, run: unbound.run };
    },
    batch: async () => [] as unknown[],
  };
  return { DB: db, ADMIN_SECRET: 'x' } as unknown as Env;
}

const env = mockDb([]);

function rpc(method: string, params?: unknown, id: unknown = 1, raw?: string): Request {
  return new Request('https://the-pit.twj.workers.dev/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

async function rpcJson(res: Response) {
  return (await res.json()) as Record<string, any>;
}

describe('MCP handshake', () => {
  it('initialize returns protocol version, tool capability, and server info', async () => {
    const res = await handleMcp(rpc('initialize', { protocolVersion: '2024-11-05' }), env);
    expect(res.status).toBe(200);
    const body = await rpcJson(res);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(body.result.capabilities).toEqual({ tools: {} });
    expect(body.result.serverInfo.name).toBe('the-pit');
    expect(typeof body.result.serverInfo.version).toBe('string');
  });

  it('notifications/initialized is a no-op 204', async () => {
    const res = await handleMcp(
      new Request('https://the-pit.twj.workers.dev/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }),
      env,
    );
    expect(res.status).toBe(204);
  });

  it('OPTIONS answers CORS preflight', async () => {
    const res = await handleMcp(
      new Request('https://the-pit.twj.workers.dev/mcp', { method: 'OPTIONS' }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('POST responses carry CORS headers', async () => {
    const res = await handleMcp(rpc('tools/list'), env);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('tools/list', () => {
  it('lists all tools with descriptions and input schemas', async () => {
    const res = await handleMcp(rpc('tools/list'), env);
    const body = await rpcJson(res);
    const tools = body.result.tools as Array<Record<string, any>>;
    const names = tools.map((t) => t.name);
    expect(names.sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(names).toContain('register_agent');
    expect(names).toContain('enter_season');
    expect(names).toContain('place_order');
    expect(names).toContain('create_league');
    for (const t of tools) {
      expect(typeof t.description, `${t.name} description`).toBe('string');
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
    }
  });
});

describe('JSON-RPC errors', () => {
  it('malformed JSON -> -32700 parse error', async () => {
    const res = await handleMcp(rpc('initialize', undefined, 1, '{not json'), env);
    const body = await rpcJson(res);
    expect(body.error.code).toBe(-32700);
    expect(body.jsonrpc).toBe('2.0');
  });

  it('unknown method -> -32601 with id echo', async () => {
    const res = await handleMcp(rpc('nope/not-real', undefined, 42), env);
    const body = await rpcJson(res);
    expect(body.id).toBe(42);
    expect(body.error.code).toBe(-32601);
  });

  it('unknown tool -> -32601', async () => {
    const res = await handleMcp(
      rpc('tools/call', { name: 'liquidate_everything', arguments: {} }, 7),
      env,
    );
    const body = await rpcJson(res);
    expect(body.id).toBe(7);
    expect(body.error.code).toBe(-32601);
  });

  it('non-object params -> -32600 invalid request', async () => {
    const res = await handleMcp(rpc('tools/list', undefined, 1, '[1,2,3]'), env);
    const body = await rpcJson(res);
    expect(body.error.code).toBe(-32600);
  });
});

describe('tools/call dispatch + validation', () => {
  it('get_quote dispatches to the REST handler and returns the quote', async () => {
    const qenv = mockDb([
      {
        match: (s) => s.includes('FROM quotes WHERE pair'),
        first: { bid: 90000, ask: 90010, ts: 1_700_000_000_000, source: 'coinbase' },
      },
    ]);
    const res = await handleMcp(
      rpc('tools/call', { name: 'get_quote', arguments: { pair: 'BTC-USD' } }),
      qenv,
    );
    const body = await rpcJson(res);
    expect(body.error).toBeUndefined();
    const text = JSON.parse(body.result.content[0].text);
    expect(text.pair).toBe('BTC/USD');
    expect(text.bid).toBe(90000);
    expect(body.result.isError).toBeUndefined();
  });

  it('get_quote accepts lowercase slash-form pairs', async () => {
    const qenv = mockDb([
      {
        match: (s) => s.includes('FROM quotes WHERE pair'),
        first: (p: unknown[]) => {
          expect(p[0]).toBe('ETH/USD');
          return { bid: 3000, ask: 3002, ts: 1, source: 'coinbase' };
        },
      },
    ]);
    const res = await handleMcp(
      rpc('tools/call', { name: 'get_quote', arguments: { pair: 'eth/usd' } }),
      qenv,
    );
    const body = await rpcJson(res);
    expect(body.error).toBeUndefined();
  });

  it('bad pair -> -32602 JSON-RPC error, not a 500', async () => {
    const res = await handleMcp(
      rpc('tools/call', { name: 'get_quote', arguments: { pair: 'FAKE-USD' } }),
      env,
    );
    const body = await rpcJson(res);
    expect(body.error.code).toBe(-32602);
    expect(body.result).toBeUndefined();
  });

  it('place_order without api_key -> -32602', async () => {
    const res = await handleMcp(
      rpc('tools/call', {
        name: 'place_order',
        arguments: { pair: 'BTC-USD', side: 'buy', type: 'market', qty: 1, rationale: 'looks good' },
      }),
      env,
    );
    const body = await rpcJson(res);
    expect(body.error.code).toBe(-32602);
  });

  it('place_order with bad side -> -32602 (parity with REST)', async () => {
    const res = await handleMcp(
      rpc('tools/call', {
        name: 'place_order',
        arguments: {
          api_key: 'pit_x', season_id: 's1', pair: 'BTC-USD',
          side: 'long', type: 'market', qty: 1, rationale: 'going long here',
        },
      }),
      env,
    );
    const body = await rpcJson(res);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('side');
  });

  it('place_order with bad type -> -32602', async () => {
    const res = await handleMcp(
      rpc('tools/call', {
        name: 'place_order',
        arguments: {
          api_key: 'pit_x', season_id: 's1', pair: 'BTC-USD',
          side: 'buy', type: 'stop', qty: 1, rationale: 'stop loss',
        },
      }),
      env,
    );
    const body = await rpcJson(res);
    expect(body.error.code).toBe(-32602);
  });

  it('place_order with bad pair -> -32602', async () => {
    const res = await handleMcp(
      rpc('tools/call', {
        name: 'place_order',
        arguments: {
          api_key: 'pit_x', season_id: 's1', pair: 'GME-USD',
          side: 'buy', type: 'market', qty: 1, rationale: 'yolo',
        },
      }),
      env,
    );
    const body = await rpcJson(res);
    expect(body.error.code).toBe(-32602);
  });

  it('place_order without rationale -> -32602 (no journal, no fill)', async () => {
    const res = await handleMcp(
      rpc('tools/call', {
        name: 'place_order',
        arguments: {
          api_key: 'pit_x', season_id: 's1', pair: 'BTC-USD',
          side: 'buy', type: 'market', qty: 1,
        },
      }),
      env,
    );
    const body = await rpcJson(res);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('rationale');
  });

  it('place_order with blank rationale -> -32602', async () => {
    const res = await handleMcp(
      rpc('tools/call', {
        name: 'place_order',
        arguments: {
          api_key: 'pit_x', season_id: 's1', pair: 'BTC-USD',
          side: 'buy', type: 'market', qty: 1, rationale: '  ',
        },
      }),
      env,
    );
    const body = await rpcJson(res);
    expect(body.error.code).toBe(-32602);
  });

  it('limit order without limit_price -> -32602', async () => {
    const res = await handleMcp(
      rpc('tools/call', {
        name: 'place_order',
        arguments: {
          api_key: 'pit_x', season_id: 's1', pair: 'BTC-USD',
          side: 'buy', type: 'limit', qty: 1, rationale: 'buying the dip',
        },
      }),
      env,
    );
    const body = await rpcJson(res);
    expect(body.error.code).toBe(-32602);
  });

  it('bad api_key -> tool isError with unauthorized (auth shared with REST)', async () => {
    const aenv = mockDb([
      {
        match: (s) => s.includes('FROM agents WHERE api_key_hash'),
        first: null, // unknown key
      },
    ]);
    const res = await handleMcp(
      rpc('tools/call', {
        name: 'place_order',
        arguments: {
          api_key: 'pit_wrong', season_id: 's1', pair: 'BTC-USD',
          side: 'buy', type: 'market', qty: 1, rationale: 'momentum entry',
        },
      }),
      aenv,
    );
    const body = await rpcJson(res);
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('unauthorized');
  });

  it('register_agent with bad email -> -32602', async () => {
    const res = await handleMcp(
      rpc('tools/call', { name: 'register_agent', arguments: { email: 'not-an-email' } }),
      env,
    );
    const body = await rpcJson(res);
    expect(body.error.code).toBe(-32602);
  });

  it('get_leaderboard with no seasons -> isError, not a crash', async () => {
    const res = await handleMcp(
      rpc('tools/call', { name: 'get_leaderboard', arguments: {} }),
      env, // empty D1: no seasons
    );
    const body = await rpcJson(res);
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
  });

  it('get_candles rejects bad timeframe and out-of-range limit', async () => {
    const badTf = await handleMcp(
      rpc('tools/call', { name: 'get_candles', arguments: { pair: 'BTC-USD', timeframe: '4h' } }),
      env,
    );
    expect((await rpcJson(badTf)).error.code).toBe(-32602);
    const badLimit = await handleMcp(
      rpc('tools/call', { name: 'get_candles', arguments: { pair: 'BTC-USD', limit: 9999 } }),
      env,
    );
    expect((await rpcJson(badLimit)).error.code).toBe(-32602);
  });
});
