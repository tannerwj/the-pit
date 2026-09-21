// The Pit — what-if engine v1: counterfactual replay over an entry's fills.
// GET /api/v1/entries/:id/whatif (agent auth, owner only).
// Replays filled orders against historical bid/ask with the live fill model.
// Honesty: no lookahead (nearest quote at-or-before each timestamp), fills at
// historical bid/ask + 5bps slippage, leverage caps not enforced in replay.

import type { Env, Side } from '../lib/types';
import { requireAgent, json, err } from '../lib/auth';
import { q, q1 } from '../lib/db';
import {
  replayCounterfactual,
  runWhatIf,
  downsamplePoints,
  type WhatIfFill,
} from '../lib/whatif';
import { quotesForTimeline, type HistoryQuote } from '../lib/history';
import type { EquityPoint } from '../lib/scoring';

const MAX_TIMELINE_POINTS = 400;
const MAX_SNAPSHOT_POINTS = 240;

interface EntryRow {
  id: string;
  season_id: string;
  agent_id: string;
  starting_capital: number;
  entered_at: number;
}

interface FillRow {
  id: string;
  pair: string;
  side: Side;
  qty: number;
  type: 'market' | 'limit';
  limit_price: number | null;
  filled_at: number;
}

function parseList(
  raw: string | null,
  def: number[],
  min: number,
  max: number,
  name: string,
): { values: number[] } | { error: string } {
  if (raw === null || raw.trim() === '') return { values: def };
  const values: number[] = [];
  for (const part of raw.split(',')) {
    const v = Number(part.trim());
    if (!Number.isFinite(v) || v <= min || v > max) {
      return { error: `"${name}" values must be in (${min}, ${max}]` };
    }
    values.push(v);
  }
  if (values.length === 0 || values.length > 5) {
    return { error: `"${name}" accepts 1-5 values` };
  }
  return { values: [...new Set(values)] };
}

/** Downsample a sorted timestamp list to at most n, always keeping first and last. */
function downsampleTs(ts: number[], n: number): number[] {
  if (ts.length <= n) return ts;
  const out: number[] = [];
  const step = (ts.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(ts[Math.round(i * step)]);
  return [...new Set(out)];
}

export async function getWhatIf(
  req: Request,
  env: Env,
  entryId: string,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;

  const entry = await q1<EntryRow>(
    env.DB,
    'SELECT id, season_id, agent_id, starting_capital, entered_at FROM season_entries WHERE id = ?',
    entryId,
  );
  if (!entry) {
    return err('entry_not_found', 'Entry not found', 404);
  }
  if (entry.agent_id !== auth.id) {
    return err('forbidden', 'This entry belongs to another agent', 403);
  }

  const params = new URL(req.url).searchParams;
  const kParsed = parseList(params.get('k'), [0.5, 2], 0, 10, 'k');
  if ('error' in kParsed) return err('bad_request', kParsed.error, 400);
  const stopParsed = parseList(params.get('stop_pct'), [10], 0, 100, 'stop_pct');
  if ('error' in stopParsed) return err('bad_request', stopParsed.error, 400);
  const skipWorstRaw = params.get('skip_worst');
  const includeSkipWorst =
    skipWorstRaw === null || skipWorstRaw === '' ? true : skipWorstRaw === '1';
  if (skipWorstRaw !== null && skipWorstRaw !== '' && skipWorstRaw !== '1' && skipWorstRaw !== '0') {
    return err('bad_request', '"skip_worst" must be 0 or 1', 400);
  }

  const fills = await q<FillRow>(
    env.DB,
    `SELECT id, pair, side, qty, type, limit_price, filled_at
     FROM orders WHERE entry_id = ? AND status = 'filled'
     ORDER BY filled_at ASC, id ASC`,
    entry.id,
  );
  const snapshots = await q<{ ts: number; equity: number }>(
    env.DB,
    'SELECT ts, equity FROM equity_snapshots WHERE entry_id = ? ORDER BY ts ASC LIMIT 5000',
    entry.id,
  );

  // Actual curve: snapshots plus the starting point (no lookahead anywhere).
  const actualPoints: EquityPoint[] = [
    { ts: entry.entered_at, equity: entry.starting_capital },
    ...snapshots.map((s) => ({ ts: s.ts, equity: s.equity })),
  ];

  if (fills.length === 0) {
    // No fills: still report the actual curve so the response shape is stable.
    const { computeAlphaScore } = await import('../lib/scoring');
    const c = computeAlphaScore(actualPoints, entry.starting_capital);
    return json({
      entry_id: entry.id,
      season_id: entry.season_id,
      fills: 0,
      actual: {
        return_pct: c.totalReturn * 100,
        max_dd: c.maxDrawdown * 100,
        sharpe: c.sharpe,
        points: downsamplePoints(actualPoints, 120),
      },
      scenarios: [],
      summary: 'No filled orders yet — nothing to replay.',
    });
  }

  // Timeline: entry start + every fill ts + downsampled snapshot ts.
  // Downsampling always keeps the first (entry start) and last (latest state)
  // points so the final equity is never discarded on long timelines.
  const snapTs = snapshots.map((s) => s.ts);
  const sampledSnapTs = downsampleTs(snapTs, MAX_SNAPSHOT_POINTS);
  const timeline = downsampleTs(
    [
      ...new Set(
        [entry.entered_at, ...fills.map((f) => f.filled_at), ...sampledSnapTs].filter(
          (t) => Number.isFinite(t) && t > 0,
        ),
      ),
    ].sort((a, b) => a - b),
    MAX_TIMELINE_POINTS,
  );

  // Historical quotes per traded pair at each timeline point.
  const pairs = [...new Set(fills.map((f) => f.pair))];
  const quotesByPair = new Map<string, HistoryQuote[]>();
  for (const pair of pairs) {
    quotesByPair.set(pair, await quotesForTimeline(env, pair, timeline));
  }

  const whatIfFills: WhatIfFill[] = fills.map((f) => ({
    id: f.id,
    pair: f.pair,
    side: f.side,
    qty: f.qty,
    type: f.type,
    limitPrice: f.limit_price,
    ts: f.filled_at,
  }));

  const result = runWhatIf({
    fills: whatIfFills,
    quotesByPair,
    timeline,
    startingCapital: entry.starting_capital,
    actualPoints,
    sizings: kParsed.values,
    stopPcts: stopParsed.values.map((s) => s / 100),
    includeSkipWorst,
    maxPoints: 120,
  });

  return json({
    entry_id: entry.id,
    season_id: entry.season_id,
    fills: fills.length,
    timeline_points: timeline.length,
    actual: result.actual,
    scenarios: result.scenarios,
    summary: result.summary,
    honesty: {
      fill_model: 'market fills at historical touch-side quote + 5bps slippage; limit fills at the limit price',
      lookahead: 'none — every replay decision uses only data available at that timestamp',
      leverage: 'leverage caps are not enforced in replay (counterfactuals, not tradable)',
    },
  });
}

// Re-exported for the k=1 identity check used in tests/docs.
export { replayCounterfactual };
