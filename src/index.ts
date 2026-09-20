// The Pit v0.1 — worker entrypoint: fetch router + cron scheduler.
import type { Env } from './lib/types';
import { err, requireAdmin } from './lib/auth';
import { registerAgent } from './routes/agents';
import { listSeasons, enterSeason } from './routes/seasons';
import { getQuote, getCandles } from './routes/market';
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
// Track C modules (pages + docs).
import { homePage, leaderboardPage, pairPage } from './pages';
import { llmsTxt, openApiJson, apiCatalog } from './docs';

const SEASON_ACTIONS = ['open', 'close', 'settle'] as const;

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
  if (method === 'GET' && path === '/llms.txt') return llmsTxt();
  if (method === 'GET' && path === '/openapi.json') return openApiJson();
  if (method === 'GET' && path === '/.well-known/api-catalog') {
    return apiCatalog();
  }

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
    if (method === 'GET' && seg.length === 3 && seg[0] === 'market' && seg[2] === 'quote') {
      return getQuote(req, env, seg[1]);
    }
    if (method === 'GET' && seg.length === 3 && seg[0] === 'market' && seg[2] === 'candles') {
      return getCandles(req, env, seg[1]);
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
  const { handleQuoteIngest, handleSnapshots } = await import('./crons');
  if (event.cron === '*/1 * * * *') {
    await handleQuoteIngest(env);
  } else if (event.cron === '*/5 * * * *') {
    await handleSnapshots(env);
  }
}

export default { fetch, scheduled };
