// The Pit v0.1 — worker entrypoint: fetch router + cron scheduler.
import type { Env } from './lib/types';
import { err, requireAdmin } from './lib/auth';
import { registerAgent } from './routes/agents';
import { listSeasons, enterSeason } from './routes/seasons';
import { getQuote, getCandles } from './routes/market';
import { getEquityCurve, getRecentTrades } from './routes/spectator';
import { placeOrder, listOrders, cancelOrder } from './routes/orders';
import { getPortfolio } from './routes/portfolio';
import { getLeaderboard } from './routes/leaderboard';
import { getJournal } from './routes/journal';
import {
  createSeason,
  seasonTransition,
  banAgent,
  takedownEntry,
  adminJournal,
} from './routes/admin';
import {
  createLeague,
  listLeagues,
  getLeague,
  updateLeague,
  createLeagueSeason,
  leagueSeasonTransition,
  leagueSeasonLeaderboard,
} from './routes/leagues';
// Track C modules (pages + docs).
import { homePage, agentsPage, leaderboardPage, pairPage, leaguesPage, leaguePage } from './pages';
import { llmsTxt, openApiJson, apiCatalog, mcpServerJson } from './docs';
import { handleMcp } from './routes/mcp';

const SEASON_ACTIONS = ['open', 'close', 'settle'] as const;
const LEAGUE_SEASON_ACTIONS = ['open', 'close', 'settle'] as const;

async function fetch(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Spectator pages + machine-readable docs (Track C, no auth).
  if (method === 'GET' && path === '/') return homePage(env);
  if (method === 'GET' && path === '/leaderboard') {
    return leaderboardPage(env, url.searchParams.get('season'));
  }
  if (method === 'GET' && path.startsWith('/pair/')) {
    return pairPage(env, decodeURIComponent(path.slice('/pair/'.length)));
  }
  if (method === 'GET' && path === '/leagues') return leaguesPage(env);
  if (method === 'GET' && path.startsWith('/league/')) {
    return leaguePage(env, decodeURIComponent(path.slice('/league/'.length)));
  }
  if (method === 'GET' && path === '/llms.txt') return llmsTxt();
  if (method === 'GET' && path === '/openapi.json') return openApiJson();
  if (method === 'GET' && path === '/.well-known/api-catalog') {
    return apiCatalog();
  }
  if (method === 'GET' && path === '/.well-known/mcp/server.json') {
    return mcpServerJson();
  }
  if (method === 'GET' && path === '/agents') return agentsPage();

  // MCP (Model Context Protocol) — Streamable HTTP, JSON-RPC 2.0.
  if (path === '/mcp') return handleMcp(req, env);

  if (path === '/api/v1' || path.startsWith('/api/v1/')) {
    const seg = path.slice('/api/v1'.length).split('/').filter(Boolean);

    // Admin routes: X-Admin-Secret gate.
    if (seg[0] === 'admin') {
      const denied = requireAdmin(req, env);
      if (denied) return denied;
      if (method === 'POST' && seg.length === 2 && seg[1] === 'seasons') {
        return createSeason(req, env);
      }
      if (
        method === 'POST' &&
        seg.length === 4 &&
        seg[1] === 'seasons' &&
        (SEASON_ACTIONS as readonly string[]).includes(seg[3])
      ) {
        return seasonTransition(
          req,
          env,
          seg[2],
          seg[3] as (typeof SEASON_ACTIONS)[number],
        );
      }
      if (
        method === 'POST' &&
        seg.length === 4 &&
        seg[1] === 'agents' &&
        (seg[3] === 'ban' || seg[3] === 'unban')
      ) {
        return banAgent(req, env, seg[2], seg[3] === 'ban');
      }
      if (
        method === 'POST' &&
        seg.length === 4 &&
        seg[1] === 'entries' &&
        seg[3] === 'takedown'
      ) {
        return takedownEntry(req, env, seg[2]);
      }
      if (
        method === 'GET' &&
        seg.length === 4 &&
        seg[1] === 'entries' &&
        seg[3] === 'journal'
      ) {
        return adminJournal(req, env, seg[2]);
      }
      return err('not_found', 'Not found', 404);
    }

    // Public + agent routes.
    if (method === 'POST' && seg.length === 2 && seg[0] === 'agents' && seg[1] === 'register') {
      return registerAgent(req, env);
    }
    if (method === 'GET' && seg.length === 1 && seg[0] === 'seasons') {
      return listSeasons(req, env);
    }
    if (method === 'POST' && seg.length === 3 && seg[0] === 'seasons' && seg[2] === 'enter') {
      return enterSeason(req, env, seg[1]);
    }
    // Fantasy leagues.
    if (seg.length === 1 && seg[0] === 'leagues') {
      if (method === 'POST') return createLeague(req, env);
      if (method === 'GET') return listLeagues(req, env);
    }
    if (seg.length === 2 && seg[0] === 'leagues') {
      if (method === 'GET') return getLeague(req, env, seg[1]);
      if (method === 'PATCH') return updateLeague(req, env, seg[1]);
    }
    if (method === 'POST' && seg.length === 3 && seg[0] === 'leagues' && seg[2] === 'seasons') {
      return createLeagueSeason(req, env, seg[1]);
    }
    if (
      method === 'POST' &&
      seg.length === 5 &&
      seg[0] === 'leagues' &&
      seg[2] === 'seasons' &&
      (LEAGUE_SEASON_ACTIONS as readonly string[]).includes(seg[4])
    ) {
      return leagueSeasonTransition(
        req,
        env,
        seg[1],
        seg[3],
        seg[4] as (typeof LEAGUE_SEASON_ACTIONS)[number],
      );
    }
    if (
      method === 'GET' &&
      seg.length === 5 &&
      seg[0] === 'leagues' &&
      seg[2] === 'seasons' &&
      seg[4] === 'leaderboard'
    ) {
      return leagueSeasonLeaderboard(req, env, seg[1], seg[3]);
    }
    if (method === 'GET' && seg.length === 3 && seg[0] === 'market' && seg[2] === 'quote') {
      return getQuote(req, env, seg[1]);
    }
    if (method === 'GET' && seg.length === 3 && seg[0] === 'market' && seg[2] === 'candles') {
      return getCandles(req, env, seg[1]);
    }
    if (method === 'GET' && seg.length === 3 && seg[0] === 'market' && seg[2] === 'trades') {
      return getRecentTrades(req, env, seg[1]);
    }
    if (seg.length === 1 && seg[0] === 'orders') {
      if (method === 'POST') return placeOrder(req, env);
      if (method === 'GET') return listOrders(req, env);
    }
    if (method === 'DELETE' && seg.length === 2 && seg[0] === 'orders') {
      return cancelOrder(req, env, seg[1]);
    }
    if (method === 'GET' && seg.length === 1 && seg[0] === 'portfolio') {
      return getPortfolio(req, env);
    }
    if (method === 'GET' && seg.length === 1 && seg[0] === 'leaderboard') {
      return getLeaderboard(req, env);
    }
    if (method === 'GET' && seg.length === 3 && seg[0] === 'entries' && seg[2] === 'journal') {
      return getJournal(req, env, seg[1]);
    }
    if (method === 'GET' && seg.length === 3 && seg[0] === 'entries' && seg[2] === 'equity') {
      return getEquityCurve(req, env, seg[1]);
    }
    return err('not_found', 'Not found', 404);
  }

  return err('not_found', 'Not found', 404);
}

// Crons (Track C): routed on event.cron, dynamically imported per contract.
async function scheduled(
  event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const { handleQuoteIngest, handleSnapshots, handleSeasonTransitions } = await import('./crons');
  if (event.cron === '*/1 * * * *') {
    await handleQuoteIngest(env);
    await handleSeasonTransitions(env);
  } else if (event.cron === '*/5 * * * *') {
    await handleSnapshots(env);
  }
}

export default { fetch, scheduled };
