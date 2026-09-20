import type { Env } from '../lib/types';
import type { ScoreComponents } from '../lib/scoring';
import { requireAgent, json, err } from '../lib/auth';
import { q, q1 } from '../lib/db';
import { midPrice } from '../lib/engine';

// GET /api/v1/portfolio?season_id= (agent auth)
export async function getPortfolio(
  req: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;
  const seasonId = new URL(req.url).searchParams.get('season_id');
  if (!seasonId) {
    return err('season_id_required', 'season_id query param is required', 400);
  }
  const entry = await q1<{
    id: string;
    status: string;
    starting_capital: number;
    cash: number;
  }>(
    env.DB,
    `SELECT id, status, starting_capital, cash FROM season_entries
     WHERE season_id = ? AND agent_id = ?`,
    seasonId,
    auth.id,
  );
  if (!entry) {
    return err('entry_not_found', 'No entry for this agent in the season', 404);
  }

  const positions = await q<{ pair: string; qty: number; avg_price: number }>(
    env.DB,
    'SELECT pair, qty, avg_price FROM positions WHERE entry_id = ? AND qty != 0',
    entry.id,
  );

  // Equity marked at the latest mid per pair; pairs with no quote yet are
  // marked at their average entry price.
  let equity = entry.cash;
  const marked = [];
  for (const p of positions) {
    const quote = await q1<{ bid: number; ask: number }>(
      env.DB,
      'SELECT bid, ask FROM quotes WHERE pair = ? ORDER BY ts DESC LIMIT 1',
      p.pair,
    );
    const mark = quote
      ? midPrice({ bid: quote.bid, ask: quote.ask, ts: 0 })
      : p.avg_price;
    equity += p.qty * mark;
    marked.push({ pair: p.pair, qty: p.qty, avg_price: p.avg_price });
  }

  const s = await q1<{
    total_return: number;
    sharpe: number;
    max_drawdown: number;
    win_rate: number;
    profit_factor: number;
    alpha_score: number;
  }>(
    env.DB,
    `SELECT total_return, sharpe, max_drawdown, win_rate, profit_factor, alpha_score
     FROM scores WHERE entry_id = ?`,
    entry.id,
  );
  const score: ScoreComponents | null = s
    ? {
        totalReturn: s.total_return,
        sharpe: s.sharpe,
        maxDrawdown: s.max_drawdown,
        winRate: s.win_rate,
        profitFactor: s.profit_factor,
        alphaScore: s.alpha_score,
      }
    : null;

  return json({
    entry: {
      id: entry.id,
      status: entry.status,
      starting_capital: entry.starting_capital,
      cash: entry.cash,
    },
    positions: marked,
    equity,
    unrealized_pnl: equity - entry.cash,
    score,
  });
}
