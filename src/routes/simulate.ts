// The Pit — public historical simulator endpoint.
// POST /api/v1/simulate (no auth; spectator-facing).
//
// Reuses the exact same pure replay core as the authenticated
// POST /api/v1/backtest (same fill model, no lookahead, 3x cap), with tighter
// bounds for anonymous use: at most 50 trades per request, plus a per-IP
// sliding-window rate limit. Reads historical quotes only — writes nothing to
// D1, ever.
//
// Rate limiting is deliberately in-memory: it is a cheap abuse guard, not a
// security boundary. Each Worker isolate keeps its own counters, so a
// determined client can exceed the nominal limit by fanning out; the tight
// trade cap keeps any single request cheap regardless.

import type { Env } from '../lib/types';
import { json, err } from '../lib/auth';
import { parseReplayBody, runReplay } from './backtest';

/** Public cap: keep anonymous simulations small and cheap. */
export const SIMULATE_MAX_TRADES = 50;
/** Per-IP sliding window: 20 requests per 60 seconds. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS = 20;
/** Guard against unbounded map growth across a long-lived isolate. */
const RATE_MAX_IPS = 10_000;

const hits = new Map<string, number[]>();

function clientIp(req: Request): string {
  const cf = req.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = req.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

/** True when the request is within the per-IP budget (and counted). */
export function simulateRateOk(ip: string, now = Date.now()): boolean {
  let arr = hits.get(ip) ?? [];
  arr = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX_HITS) {
    hits.set(ip, arr);
    return false;
  }
  arr.push(now);
  if (hits.size >= RATE_MAX_IPS) {
    // Shed the stalest buckets instead of growing forever.
    for (const [k, v] of hits) {
      if (v.length === 0 || now - v[v.length - 1] >= RATE_WINDOW_MS) hits.delete(k);
      if (hits.size < RATE_MAX_IPS) break;
    }
  }
  hits.set(ip, arr);
  return true;
}

/** Test hook — clears all rate-limit counters. */
export function resetSimulateRateLimit(): void {
  hits.clear();
}

export async function postSimulate(req: Request, env: Env): Promise<Response> {
  if (!simulateRateOk(clientIp(req))) {
    const res = err(
      'rate_limited',
      'Too many simulation requests — please wait a minute and try again.',
      429,
    );
    res.headers.set('Retry-After', '60');
    return res;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err('bad_request', 'Invalid JSON body', 400);
  }

  const parsed = parseReplayBody(body, Date.now(), SIMULATE_MAX_TRADES);
  if ('error' in parsed) return err('bad_request', parsed.error, parsed.status);
  const payload = await runReplay(env, parsed.startingCapital, parsed.trades, {
    from: parsed.from,
    to: parsed.to,
  });
  return json(payload);
}
