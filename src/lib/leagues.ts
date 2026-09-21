// The Pit wave 3 — league + multi-pair season params (pure helpers, no I/O).
// DB stores pairs as 'BTC/USD'; URL form is 'BTC-USD' (dash).

export const SUPPORTED_PAIRS = [
  'BTC/USD',
  'ETH/USD',
  'SOL/USD',
  'XRP/USD',
  'DOGE/USD',
] as const;
export type DbPair = (typeof SUPPORTED_PAIRS)[number];

export interface SeasonParams {
  pairs: string[]; // subset of SUPPORTED_PAIRS (DB form)
  season_days: number; // 1..30
  starting_capital: number; // 1000..100000
  max_leverage: number; // 1..3
  allow_short: boolean;
}

export const DEFAULT_SEASON_PARAMS: SeasonParams = {
  pairs: [...SUPPORTED_PAIRS],
  season_days: 14,
  starting_capital: 10000,
  max_leverage: 3,
  allow_short: true,
};

export const MIN_SEASON_DAYS = 1;
export const MAX_SEASON_DAYS = 30;
export const MIN_CAPITAL = 1000;
export const MAX_CAPITAL = 100000;
export const MIN_LEVERAGE = 1;
export const MAX_LEVERAGE_PARAM = 3;
export const MIN_AGENTS = 2;
export const MAX_AGENTS = 100;

/** Parse a seasons.params JSON snapshot; fall back to official defaults on junk. */
export function parseSeasonParams(raw: string | null | undefined): SeasonParams {
  if (!raw) return { ...DEFAULT_SEASON_PARAMS, pairs: [...DEFAULT_SEASON_PARAMS.pairs] };
  try {
    const p = JSON.parse(raw) as Partial<SeasonParams>;
    const pairs = Array.isArray(p.pairs)
      ? p.pairs.filter((x): x is string => typeof x === 'string' && (SUPPORTED_PAIRS as readonly string[]).includes(x))
      : [];
    return {
      pairs: pairs.length > 0 ? pairs : [...SUPPORTED_PAIRS],
      season_days: numIn(p.season_days, DEFAULT_SEASON_PARAMS.season_days, MIN_SEASON_DAYS, MAX_SEASON_DAYS),
      starting_capital: numIn(p.starting_capital, DEFAULT_SEASON_PARAMS.starting_capital, MIN_CAPITAL, MAX_CAPITAL),
      max_leverage: numIn(p.max_leverage, DEFAULT_SEASON_PARAMS.max_leverage, MIN_LEVERAGE, MAX_LEVERAGE_PARAM),
      allow_short: p.allow_short !== false,
    };
  } catch {
    return { ...DEFAULT_SEASON_PARAMS, pairs: [...DEFAULT_SEASON_PARAMS.pairs] };
  }
}

function numIn(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
}

export interface LeagueParamsInput {
  pairs?: unknown;
  season_days?: unknown;
  starting_capital?: unknown;
  max_leverage?: unknown;
  allow_short?: unknown;
  max_agents?: unknown;
  visibility?: unknown;
  name?: unknown;
  description?: unknown;
}

export interface ValidatedLeague {
  params: SeasonParams;
  max_agents: number;
  visibility: 'public' | 'private';
  name: string;
  description: string;
}

/** Validate league-creation (or pre-season edit) params. Throws Error on invalid. */
export function validateLeagueInput(body: LeagueParamsInput): ValidatedLeague {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length === 0 || name.length > 80) {
    throw new Error('name must be 1-80 characters');
  }
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '';

  const rawPairs = body.pairs;
  let pairs: string[];
  if (rawPairs === undefined) {
    pairs = [...SUPPORTED_PAIRS];
  } else if (
    Array.isArray(rawPairs) &&
    rawPairs.length > 0 &&
    rawPairs.every((p) => typeof p === 'string' && (SUPPORTED_PAIRS as readonly string[]).includes(p))
  ) {
    pairs = [...new Set(rawPairs as string[])];
  } else {
    throw new Error(`pairs must be a non-empty array drawn from ${SUPPORTED_PAIRS.join(', ')}`);
  }

  const season_days = intIn(body.season_days, NaN, MIN_SEASON_DAYS, MAX_SEASON_DAYS);
  const starting_capital = numInStrict(body.starting_capital, NaN, MIN_CAPITAL, MAX_CAPITAL);
  const max_leverage = numInStrict(body.max_leverage, NaN, MIN_LEVERAGE, MAX_LEVERAGE_PARAM);
  const max_agents =
    body.max_agents === undefined ? MAX_AGENTS : intIn(body.max_agents, NaN, MIN_AGENTS, MAX_AGENTS);
  if (!Number.isFinite(season_days)) throw new Error(`season_days must be an integer ${MIN_SEASON_DAYS}-${MAX_SEASON_DAYS}`);
  if (!Number.isFinite(starting_capital)) throw new Error(`starting_capital must be ${MIN_CAPITAL}-${MAX_CAPITAL}`);
  if (!Number.isFinite(max_leverage)) throw new Error(`max_leverage must be ${MIN_LEVERAGE}-${MAX_LEVERAGE_PARAM}`);
  if (!Number.isFinite(max_agents)) throw new Error(`max_agents must be an integer ${MIN_AGENTS}-${MAX_AGENTS}`);

  const visibility = body.visibility === undefined || body.visibility === 'public' ? 'public' : body.visibility === 'private' ? 'private' : null;
  if (!visibility) throw new Error("visibility must be 'public' or 'private'");

  const allow_short = body.allow_short === undefined ? true : body.allow_short === true;
  if (body.allow_short !== undefined && body.allow_short !== true && body.allow_short !== false) {
    throw new Error('allow_short must be a boolean');
  }

  return {
    params: { pairs, season_days, starting_capital, max_leverage, allow_short },
    max_agents,
    visibility,
    name,
    description,
  };
}

function intIn(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;
}
function numInStrict(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
}

/** URL-safe slug from a league name; caller appends a suffix on collision. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'league';
}

/** Random invite code for private leagues (shown once at creation). */
export function newInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 32]).join('');
}
