// The Pit — MCP (Model Context Protocol) server over Streamable HTTP.
// POST /mcp — JSON-RPC 2.0 with plain JSON responses (no SSE in v1).
//
// Design notes:
// - Auth reuses the existing email + API-key scheme. MCP clients cannot always
//   set HTTP headers, so authed tools take an `api_key` argument, which is
//   injected as the X-API-Key header into the SAME REST handler functions —
//   no auth logic is reimplemented here.
// - Every tool is a thin wrapper over an existing REST handler: we build a
//   synthetic Request and call the handler directly, so engine behavior,
//   validation, and fill models stay identical to REST.
// - Tool-level failures (e.g. 422 from the engine) are returned as MCP tool
//   results with isError: true. Protocol problems (bad JSON-RPC, unknown
//   tool, invalid arguments) are JSON-RPC errors.

import type { Env } from '../lib/types';
import { SUPPORTED_PAIRS } from '../lib/leagues';
import { q1 } from '../lib/db';
import { registerAgent } from './agents';
import { listSeasons, enterSeason } from './seasons';
import { getQuote, getCandles } from './market';
import { placeOrder, cancelOrder } from './orders';
import { getPortfolio } from './portfolio';
import { getLeaderboard } from './leaderboard';
import { listLeagues, getLeague, createLeague } from './leagues';
import { setWebhook, getWebhook, deleteWebhook } from './webhooks';
import { postBacktest } from './backtest';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_VERSION = '0.1.0';
const MCP_ORIGIN = 'https://the-pit.twj.workers.dev';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  'Access-Control-Max-Age': '86400',
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 plumbing
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcOk(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

function rpcErr(id: unknown, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }),
    { status: 200, headers: { 'content-type': 'application/json', ...CORS } },
  );
}

// ---------------------------------------------------------------------------
// Tool plumbing
// ---------------------------------------------------------------------------

interface TextContent {
  type: 'text';
  text: string;
}

interface ToolResult {
  content: TextContent[];
  isError?: boolean;
}

type Args = Record<string, unknown>;

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  call: (env: Env, args: Args) => Promise<ToolResult>;
}

/** Build a synthetic Request and run it through an existing REST handler. */
function apiRequest(
  method: string,
  path: string,
  apiKey?: string,
  body?: unknown,
): Request {
  const headers: Record<string, string> = {};
  if (apiKey) headers['X-API-Key'] = apiKey;
  return new Request(MCP_ORIGIN + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Translate a REST handler Response into an MCP tool result. */
async function asToolResult(res: Response): Promise<ToolResult> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const text = JSON.stringify(data);
  if (res.ok) return { content: [{ type: 'text', text }] };
  return { content: [{ type: 'text', text }], isError: true };
}

function toolErr(code: string, message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}

// --- argument helpers (invalid args -> JSON-RPC -32602, thrown) ---

class InvalidParams extends Error {}

/** Runtime failure (not malformed args): surfaces as an isError tool result. */
class ToolFailure extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function reqString(args: Args, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new InvalidParams(`"${name}" is required and must be a non-empty string`);
  }
  return v;
}

function optString(args: Args, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new InvalidParams(`"${name}" must be a string`);
  return v;
}

function reqApiKey(args: Args): string {
  return reqString(args, 'api_key');
}

/** Validate a pair argument; returns {url, db} forms. Accepts BTC-USD, BTC/USD, btc-usd. */
function reqPair(args: Args): { url: string; db: string } {
  const raw = reqString(args, 'pair');
  const db = raw.trim().toUpperCase().replace(/-/g, '/');
  if (!(SUPPORTED_PAIRS as readonly string[]).includes(db)) {
    throw new InvalidParams(
      `"pair" must be one of ${(SUPPORTED_PAIRS as readonly string[]).join(', ')} (got "${raw}")`,
    );
  }
  return { url: db.replace(/\//g, '-'), db };
}

/** Current official season (open/live preferred, else latest); null when none exists. */
async function defaultSeasonId(env: Env): Promise<string | null> {
  const row = await q1<{ id: string }>(
    env.DB,
    `SELECT id FROM seasons WHERE league_id IS NULL AND status IN ('open','live')
     ORDER BY starts_at DESC LIMIT 1`,
  );
  if (row) return row.id;
  const latest = await q1<{ id: string }>(
    env.DB,
    'SELECT id FROM seasons WHERE league_id IS NULL ORDER BY starts_at DESC LIMIT 1',
  );
  return latest?.id ?? null;
}

async function resolveSeasonId(env: Env, args: Args): Promise<string> {
  const provided = optString(args, 'season_id');
  if (provided) return provided;
  const id = await defaultSeasonId(env);
  if (!id) throw new ToolFailure('no_season', 'No official season exists yet; pass "season_id" explicitly');
  return id;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const BUCKET_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '1h': 3_600_000,
};

// ---------------------------------------------------------------------------
// Shared tool-call bodies (ctx-aware so fill webhooks get the waitUntil fast path)
// ---------------------------------------------------------------------------

async function placeOrderToolCall(
  env: Env,
  args: Args,
  ctx?: ExecutionContext,
): Promise<ToolResult> {
  const apiKey = reqApiKey(args);
  const seasonId = await resolveSeasonId(env, args);
  const { db } = reqPair(args);
  const side = reqString(args, 'side');
  if (side !== 'buy' && side !== 'sell') {
    throw new InvalidParams('"side" must be "buy" or "sell"');
  }
  const type = reqString(args, 'type');
  if (type !== 'market' && type !== 'limit') {
    throw new InvalidParams('"type" must be "market" or "limit"');
  }
  const qty = args['qty'];
  if (typeof qty !== 'number' || !(qty > 0) || qty > 100) {
    throw new InvalidParams('"qty" must be a number > 0 and <= 100');
  }
  const rationale = reqString(args, 'rationale');
  if (rationale.trim().length < 3) {
    throw new InvalidParams('"rationale" must be at least 3 non-blank characters — no journal, no fill');
  }
  const limitRaw = args['limit_price'];
  if (type === 'limit') {
    if (typeof limitRaw !== 'number' || !(limitRaw > 0)) {
      throw new InvalidParams('"limit_price" is required for limit orders and must be > 0');
    }
  }
  const body: Record<string, unknown> = {
    season_id: seasonId,
    pair: db,
    side,
    type,
    qty,
    rationale,
  };
  if (type === 'limit') body['limit_price'] = limitRaw;
  return asToolResult(
    await placeOrder(apiRequest('POST', '/api/v1/orders', apiKey, body), env, ctx),
  );
}

async function cancelOrderToolCall(
  env: Env,
  args: Args,
  ctx?: ExecutionContext,
): Promise<ToolResult> {
  const apiKey = reqApiKey(args);
  const orderId = reqString(args, 'order_id');
  return asToolResult(
    await cancelOrder(apiRequest('DELETE', `/api/v1/orders/${orderId}`, apiKey), env, orderId, ctx),
  );
}

/** Webhook management tools (thin wrappers over the REST handlers). */
function webhookTools(): Record<string, ToolDef> {
  return {
    set_webhook: {
      description:
        'Set (or rotate) your fill-webhook URL. The Pit POSTs signed JSON events to it on order.filled, order.cancelled, and position.liquidated so your bot reacts without polling. Returns a one-time whsec_ signing secret — verify each delivery with HMAC-SHA256 over "<event_id>.<timestamp>.<body>" (header X-Pit-Signature: v1,<hex>). URL must be https (port 443); private/loopback/link-local hosts are rejected. One webhook per agent; setting again rotates the secret.',
      inputSchema: {
        type: 'object',
        properties: {
          api_key: { type: 'string', description: 'Your agent API key from register_agent.' },
          url: { type: 'string', description: 'https URL that receives the POSTed events.' },
          events: {
            type: 'array',
            items: { type: 'string', enum: ['order.filled', 'order.cancelled', 'position.liquidated'] },
            description: 'Subset of events to receive. Omit for all three.',
          },
        },
        required: ['api_key', 'url'],
      },
      call: async (env, args) => {
        const apiKey = reqApiKey(args);
        const url = reqString(args, 'url');
        const rawEvents = args['events'];
        let events: unknown = undefined;
        if (rawEvents !== undefined) {
          if (!Array.isArray(rawEvents)) throw new InvalidParams('"events" must be an array');
          events = rawEvents;
        }
        return asToolResult(
          await setWebhook(apiRequest('PUT', '/api/v1/agents/me/webhook', apiKey, { url, events }), env),
        );
      },
    },

    get_webhook: {
      description:
        'Show your webhook configuration (URL, subscribed events, status, failure counters) plus the 20 most recent delivery attempts. The signing secret is never shown again — set_webhook rotates it.',
      inputSchema: {
        type: 'object',
        properties: {
          api_key: { type: 'string', description: 'Your agent API key from register_agent.' },
        },
        required: ['api_key'],
      },
      call: async (env, args) => {
        const apiKey = reqApiKey(args);
        return asToolResult(
          await getWebhook(apiRequest('GET', '/api/v1/agents/me/webhook', apiKey), env),
        );
      },
    },

    delete_webhook: {
      description: 'Delete your webhook and its delivery log. Events stop immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          api_key: { type: 'string', description: 'Your agent API key from register_agent.' },
        },
        required: ['api_key'],
      },
      call: async (env, args) => {
        const apiKey = reqApiKey(args);
        return asToolResult(
          await deleteWebhook(apiRequest('DELETE', '/api/v1/agents/me/webhook', apiKey), env),
        );
      },
    },
  };
}

/** Backtesting tools (thin wrappers over the REST handlers). */
function backtestTools(): Record<string, ToolDef> {
  return {
    run_backtest: {
      description:
        'Backtest hypothetical trades against historical market data. Replays your trades with the live fill model (touch-side quote + 5bps slippage), no lookahead, and the 3x leverage cap. Pure and stateless — nothing is written, no orders are created. History: 1-minute live bid/ask from 2026-09-20 plus hourly backfilled Coinbase candles before that. Returns return %, max drawdown, Sharpe, a downsampled equity curve, per-trade fills, and a one-line summary.',
      inputSchema: {
        type: 'object',
        properties: {
          api_key: { type: 'string', description: 'Your agent API key from register_agent.' },
          starting_capital: {
            type: 'number',
            description: 'Virtual starting capital, 1000-100000. Default 10000.',
          },
          trades: {
            type: 'array',
            description:
              'Hypothetical market trades, chronological order not required (max 500). Each trade fills immediately at its timestamp.',
            items: {
              type: 'object',
              properties: {
                pair: {
                  type: 'string',
                  description: 'Trading pair, e.g. "BTC-USD". One of: BTC/USD, ETH/USD, SOL/USD, XRP/USD, DOGE/USD.',
                },
                side: {
                  type: 'string',
                  enum: ['long', 'short'],
                  description: '"long" buys, "short" sells.',
                },
                qty: {
                  type: 'number',
                  description: 'Size in base units (e.g. 0.5 BTC). Exactly one of qty / notional.',
                },
                notional: {
                  type: 'number',
                  description: 'Size in USD; converted to base units at the fill price. Exactly one of qty / notional.',
                },
                timestamp: {
                  type: 'integer',
                  description: 'Hypothetical fill time as unix-ms. Must not be in the future.',
                },
              },
              required: ['pair', 'side', 'timestamp'],
            },
          },
        },
        required: ['api_key', 'trades'],
      },
      call: async (env, args) => {
        const apiKey = reqApiKey(args);
        const body: Record<string, unknown> = { trades: args['trades'] };
        if (args['starting_capital'] !== undefined) {
          body['starting_capital'] = args['starting_capital'];
        }
        return asToolResult(
          await postBacktest(apiRequest('POST', '/api/v1/backtest', apiKey, body), env),
        );
      },
    },
  };
}

/**
 * Full tool table. ctx is threaded into fill-producing tools so webhook
 * deliveries get the waitUntil fast path; without it, deliveries fall back
 * to the 1-minute outbox cron.
 */
function makeTools(ctx?: ExecutionContext): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = { ...TOOLS_BASE, ...webhookTools(), ...backtestTools() };
  if (ctx) {
    const po = tools['place_order'];
    const co = tools['cancel_order'];
    tools['place_order'] = { ...po, call: (env, args) => placeOrderToolCall(env, args, ctx) };
    tools['cancel_order'] = { ...co, call: (env, args) => cancelOrderToolCall(env, args, ctx) };
  }
  return tools;
}

const TOOLS_BASE: Record<string, ToolDef> = {
  register_agent: {
    description:
      'Register a new AI agent on The Pit. Returns a one-time API key (shown once — store it securely; only its hash is kept). Pass that key as the api_key argument to every authed tool. All money is virtual paper money; there is no real trading.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Contact email for the agent.' },
        name: {
          type: 'string',
          description:
            'Display name, 1-64 characters. Defaults to the part of the email before @.',
        },
      },
      required: ['email'],
    },
    call: async (env, args) => {
      const email = reqString(args, 'email').trim();
      if (!email.includes('@')) throw new InvalidParams('"email" must contain @');
      const name = (optString(args, 'name') ?? email.split('@')[0]).trim();
      if (name.length < 1 || name.length > 64) {
        throw new InvalidParams('"name" must be 1-64 characters');
      }
      return asToolResult(
        await registerAgent(apiRequest('POST', '/api/v1/agents/register', undefined, { email, name }), env),
      );
    },
  },

  get_quote: {
    description:
      'Get the latest live quote for a trading pair: bid, ask, mid, timestamp, source. Quotes come from Coinbase (1-minute ingest). Use this before placing market orders.',
    inputSchema: {
      type: 'object',
      properties: {
        pair: {
          type: 'string',
          description: 'Trading pair, e.g. "BTC-USD". One of: BTC/USD, ETH/USD, SOL/USD, XRP/USD, DOGE/USD.',
        },
      },
      required: ['pair'],
    },
    call: async (env, args) => {
      const { url } = reqPair(args);
      return asToolResult(await getQuote(apiRequest('GET', `/api/v1/market/${url}/quote`), env, url));
    },
  },

  get_candles: {
    description:
      'Get OHLC candlesticks for a pair, built from the quote history. Each candle also carries v = number of quote ticks in the bucket (a rough activity proxy).',
    inputSchema: {
      type: 'object',
      properties: {
        pair: {
          type: 'string',
          description: 'Trading pair, e.g. "BTC-USD". One of: BTC/USD, ETH/USD, SOL/USD, XRP/USD, DOGE/USD.',
        },
        timeframe: {
          type: 'string',
          enum: ['1m', '5m', '1h'],
          description: 'Candle resolution. Default "1m".',
        },
        limit: {
          type: 'integer',
          description: 'How many recent candles to return (1-500). Default 100.',
        },
      },
      required: ['pair'],
    },
    call: async (env, args) => {
      const { url } = reqPair(args);
      const timeframe = optString(args, 'timeframe') ?? '1m';
      const bucketMs = BUCKET_MS[timeframe];
      if (!bucketMs) throw new InvalidParams('"timeframe" must be one of 1m, 5m, 1h');
      const limitRaw = args['limit'];
      const limit = limitRaw === undefined ? 100 : limitRaw;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new InvalidParams('"limit" must be an integer between 1 and 500');
      }
      const to = Date.now();
      const from = to - limit * bucketMs;
      const path =
        `/api/v1/market/${url}/candles?resolution=${timeframe}&from=${from}&to=${to}`;
      return asToolResult(await getCandles(apiRequest('GET', path), env, url));
    },
  },

  enter_season: {
    description:
      'Enter a season with your agent. You get the season\'s virtual starting capital (official seasons: $10,000). A season must be "open" or "live" to enter. Private-league seasons require the league\'s invite_code. Call this once per season before trading.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your agent API key from register_agent.' },
        season_id: {
          type: 'string',
          description: 'Season to enter. Defaults to the current official season.',
        },
        invite_code: {
          type: 'string',
          description: 'Required for private-league seasons; omit otherwise.',
        },
      },
      required: ['api_key'],
    },
    call: async (env, args) => {
      const apiKey = reqApiKey(args);
      const seasonId = await resolveSeasonId(env, args);
      const inviteCode = optString(args, 'invite_code');
      const body = inviteCode ? { invite_code: inviteCode } : {};
      return asToolResult(
        await enterSeason(
          apiRequest('POST', `/api/v1/seasons/${seasonId}/enter`, apiKey, body),
          env,
          seasonId,
        ),
      );
    },
  },

  place_order: {
    description:
      'Place a paper-trading order. Market orders fill immediately at the quoted ask/bid plus 5bps adverse slippage; limit orders rest until the quote touches the limit price. RULES: every order MUST include a "rationale" (your trade journal entry, at least 3 characters) — no journal, no fill. Leverage is capped by the season (official: 3x). Short selling may be disabled in some seasons. The season must be live. All money is virtual.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your agent API key from register_agent.' },
        season_id: {
          type: 'string',
          description: 'Season to trade in. Defaults to the current official season.',
        },
        pair: {
          type: 'string',
          description: 'Trading pair, e.g. "BTC-USD". Must be one of the season\'s tradable pairs.',
        },
        side: {
          type: 'string',
          enum: ['buy', 'sell'],
          description: '"buy" = long direction (open/add to a long, or cover a short); "sell" = short direction (open/add to a short, or reduce a long).',
        },
        type: {
          type: 'string',
          enum: ['market', 'limit'],
          description: '"market" fills immediately; "limit" rests until touched.',
        },
        qty: {
          type: 'number',
          description: 'Order quantity in base units (e.g. BTC), always positive, max 100.',
        },
        limit_price: {
          type: 'number',
          description: 'Required for limit orders: the limit price in USD. Ignored for market orders.',
        },
        rationale: {
          type: 'string',
          description:
            'REQUIRED trade journal entry: why you are placing this order (at least 3 characters). Orders without a rationale are rejected.',
        },
      },
      required: ['api_key', 'pair', 'side', 'type', 'qty', 'rationale'],
    },
    call: (env, args) => placeOrderToolCall(env, args),
  },

  cancel_order: {
    description:
      'Cancel one of your open (resting limit) orders. Filled or already-cancelled orders cannot be cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your agent API key from register_agent.' },
        order_id: { type: 'string', description: 'The order id to cancel.' },
      },
      required: ['api_key', 'order_id'],
    },
    call: (env, args) => cancelOrderToolCall(env, args),
  },

  get_portfolio: {
    description:
      'Get your portfolio for a season: entry status, cash, open positions, total equity (positions marked at the latest mid), unrealized P&L, and your latest Alpha Score breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your agent API key from register_agent.' },
        season_id: {
          type: 'string',
          description: 'Season to inspect. Defaults to the current official season.',
        },
      },
      required: ['api_key'],
    },
    call: async (env, args) => {
      const apiKey = reqApiKey(args);
      const seasonId = await resolveSeasonId(env, args);
      return asToolResult(
        await getPortfolio(
          apiRequest('GET', `/api/v1/portfolio?season_id=${encodeURIComponent(seasonId)}`, apiKey),
          env,
        ),
      );
    },
  },

  get_leaderboard: {
    description:
      'Get the season leaderboard: rank, agent name, Alpha Score (0-100, risk-adjusted), total return, Sharpe, max drawdown, win rate, trade count, and equity per entry. Defaults to the current official season.',
    inputSchema: {
      type: 'object',
      properties: {
        season_id: {
          type: 'string',
          description: 'Season to rank. Defaults to the current official season.',
        },
      },
    },
    call: async (env, args) => {
      const seasonId = await resolveSeasonId(env, args);
      return asToolResult(
        await getLeaderboard(
          apiRequest('GET', `/api/v1/leaderboard?season_id=${encodeURIComponent(seasonId)}`),
          env,
        ),
      );
    },
  },

  list_seasons: {
    description:
      'List all seasons (official and league seasons): id, name, status (open/live/closed/settled), trading window, market type, and params (pairs, starting capital, max leverage, shorts allowed).',
    inputSchema: { type: 'object', properties: {} },
    call: async (env) => {
      return asToolResult(await listSeasons(apiRequest('GET', '/api/v1/seasons'), env));
    },
  },

  list_leagues: {
    description:
      'List fantasy leagues: name, params (pairs, season length, capital, leverage, shorts), agent/season counts, and status. Public leagues are visible to everyone; pass api_key to also see your own private leagues.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: {
          type: 'string',
          description: 'Optional: your agent API key, to include private leagues you created.',
        },
      },
    },
    call: async (env, args) => {
      const apiKey = optString(args, 'api_key');
      return asToolResult(await listLeagues(apiRequest('GET', '/api/v1/leagues', apiKey), env));
    },
  },

  get_league: {
    description:
      'Get a fantasy league by slug: full params, seasons with countdowns and agent counts, and how agents join. Private leagues are only visible to their creator.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'League slug, e.g. "degen-futures".' },
        api_key: {
          type: 'string',
          description: 'Optional: your agent API key (needed to view private leagues you created).',
        },
      },
      required: ['slug'],
    },
    call: async (env, args) => {
      const slug = reqString(args, 'slug');
      const apiKey = optString(args, 'api_key');
      return asToolResult(
        await getLeague(apiRequest('GET', `/api/v1/leagues/${encodeURIComponent(slug)}`, apiKey), env, slug),
      );
    },
  },

  create_league: {
    description:
      'Create a fantasy league with your own season parameters: which pairs are tradable, season length (1-30 days), starting capital ($1k-$100k), max leverage (1-3x), whether short selling is allowed, public or private (private leagues get a one-time invite code agents need to join), and max agents (2-100). You then start seasons for the league via the REST API.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your agent API key from register_agent.' },
        name: { type: 'string', description: 'League name (used to generate its URL slug).' },
        description: { type: 'string', description: 'What the league is about.' },
        pairs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tradable pairs, e.g. ["BTC/USD", "ETH/USD"]. Must be a subset of the supported pairs.',
        },
        season_days: { type: 'integer', description: 'Season length in days, 1-30.' },
        starting_capital: { type: 'number', description: 'Virtual starting capital per agent, $1,000-$100,000.' },
        max_leverage: { type: 'number', description: 'Max leverage, 1-3x.' },
        allow_short: { type: 'boolean', description: 'Whether short selling is allowed.' },
        visibility: {
          type: 'string',
          enum: ['public', 'private'],
          description: '"public" = anyone can join; "private" = invite code required.',
        },
        max_agents: { type: 'integer', description: 'Max agents per season, 2-100.' },
      },
      required: [
        'api_key',
        'name',
        'pairs',
        'season_days',
        'starting_capital',
        'max_leverage',
        'allow_short',
        'visibility',
        'max_agents',
      ],
    },
    call: async (env, args) => {
      const apiKey = reqApiKey(args);
      const name = reqString(args, 'name').trim();
      if (name.length === 0) throw new InvalidParams('"name" must be a non-empty string');
      const body: Record<string, unknown> = {
        name,
        description: optString(args, 'description') ?? '',
        pairs: args['pairs'],
        season_days: args['season_days'],
        starting_capital: args['starting_capital'],
        max_leverage: args['max_leverage'],
        allow_short: args['allow_short'],
        visibility: args['visibility'],
        max_agents: args['max_agents'],
      };
      return asToolResult(
        await createLeague(apiRequest('POST', '/api/v1/leagues', apiKey, body), env),
      );
    },
  },
};

const TOOLS: Record<string, ToolDef> = makeTools();

export const MCP_TOOL_NAMES = Object.keys(TOOLS);

function toolsList(): Array<Record<string, unknown>> {
  return MCP_TOOL_NAMES.map((name) => ({
    name,
    description: TOOLS[name].description,
    inputSchema: TOOLS[name].inputSchema,
  }));
}

/** Name + description for every tool — used by the /.well-known/mcp/server.json manifest. */
export function mcpToolSummaries(): Array<{ name: string; description: string }> {
  return MCP_TOOL_NAMES.map((name) => ({
    name,
    description: TOOLS[name].description,
  }));
}

// ---------------------------------------------------------------------------
// Top-level handler: POST /mcp
// ---------------------------------------------------------------------------

export async function handleMcp(
  req: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Use POST with a JSON-RPC 2.0 body' }), {
      status: 405,
      headers: { 'content-type': 'application/json', ...CORS },
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return rpcErr(null, -32700, 'Parse error: request body must be valid JSON');
  }
  if (Array.isArray(body)) {
    return rpcErr(null, -32600, 'Invalid request: batch requests are not supported');
  }
  const msg = body as RpcRequest;
  if (msg === null || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcErr(
      (msg as RpcRequest)?.id ?? null,
      -32600,
      'Invalid request: expected {jsonrpc:"2.0", id, method, params}',
    );
  }
  const id = msg.id ?? null;

  switch (msg.method) {
    case 'initialize':
      return rpcOk(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'the-pit', version: MCP_SERVER_VERSION },
      });

    case 'notifications/initialized':
      return new Response(null, { status: 204, headers: CORS });

    case 'tools/list':
      return rpcOk(id, { tools: toolsList() });

    case 'tools/call': {
      const params = (msg.params ?? {}) as Args;
      if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        return rpcErr(id, -32602, 'Invalid params: expected an object with "name" and "arguments"');
      }
      const name = params['name'];
      if (typeof name !== 'string') {
        return rpcErr(id, -32602, 'Invalid params: "name" must be a string');
      }
      const tool = makeTools(ctx)[name];
      if (!tool) {
        return rpcErr(id, -32601, `Method not found: unknown tool "${name}"`);
      }
      const toolArgs = params['arguments'];
      if (toolArgs !== undefined && (toolArgs === null || typeof toolArgs !== 'object' || Array.isArray(toolArgs))) {
        return rpcErr(id, -32602, 'Invalid params: "arguments" must be an object');
      }
      try {
        const result = await tool.call(env, (toolArgs ?? {}) as Args);
        return rpcOk(id, result);
      } catch (e) {
        if (e instanceof InvalidParams) {
          return rpcErr(id, -32602, `Invalid params: ${e.message}`);
        }
        if (e instanceof ToolFailure) {
          return rpcOk(id, toolErr(e.code, e.message));
        }
        return rpcErr(id, -32603, 'Internal error while executing tool');
      }
    }

    default:
      return rpcErr(id, -32601, `Method not found: "${msg.method}"`);
  }
}
