import type { Env } from '../lib/types';
import { json, err } from '../lib/auth';
import { q, q1 } from '../lib/db';

export interface LeaderboardEntry {
  rank: number;
  agent_name: string;
  alpha_score: number | null;
  total_return: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  win_rate: number | null;
  profit_factor: number | null;
  trades: number;
  equity: number;
}

/** Season leaderboard rows, or null when the season doesn't exist. Pair-agnostic: entries hold positions across pairs; equity is the single source of truth. */
export async function leaderboardForSeason(
  env: Env,
  seasonId: string,
): Promise<LeaderboardEntry[] | null> {
  const season = await q1<{ id: string }>(
    env.DB,
    'SELECT id FROM seasons WHERE id = ?',
    seasonId,
  );
  if (!season) return null;

  const rows = await q<{
    agent_name: string;
    cash: number;
    alpha_score: number | null;
    total_return: number | null;
    sharpe: number | null;
    max_drawdown: number | null;
    win_rate: number | null;
    profit_factor: number | null;
    trades: number;
    equity: number | null;
  }>(
    env.DB,
    `SELECT a.name AS agent_name, e.cash,
            s.alpha_score, s.total_return, s.sharpe, s.max_drawdown, s.win_rate, s.profit_factor,
            (SELECT COUNT(*) FROM orders o WHERE o.entry_id = e.id) AS trades,
            (SELECT es.equity FROM equity_snapshots es
             WHERE es.entry_id = e.id ORDER BY es.ts DESC LIMIT 1) AS equity
     FROM season_entries e
     JOIN agents a ON a.id = e.agent_id
     LEFT JOIN scores s ON s.entry_id = e.id
     WHERE e.season_id = ?
     ORDER BY s.alpha_score IS NULL, s.alpha_score DESC`,
    seasonId,
  );

  return rows.map((r, i) => ({
    rank: i + 1,
    agent_name: r.agent_name,
    alpha_score: r.alpha_score,
    total_return: r.total_return,
    sharpe: r.sharpe,
    max_drawdown: r.max_drawdown,
    win_rate: r.win_rate,
    profit_factor: r.profit_factor,
    trades: r.trades,
    equity: r.equity ?? r.cash,
  }));
}

// GET /api/v1/leaderboard?season_id=&pair= (public)
export async function getLeaderboard(
  req: Request,
  env: Env,
): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const seasonId = params.get('season_id');
  if (!seasonId) {
    return err('season_id_required', 'season_id query param is required', 400);
  }
  const entries = await leaderboardForSeason(env, seasonId);
  if (!entries) {
    return err('season_not_found', 'Season not found', 404);
  }
  return json({ season_id: seasonId, entries });
}
