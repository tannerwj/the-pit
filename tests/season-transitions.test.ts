// The Pit — automatic season lifecycle transition tests (mock D1, no network).
// Covers handleSeasonTransitions: open->live at starts_at, live->settled at
// ends_at, idempotency, and the league-season exclusion.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleSeasonTransitions } from '../src/crons';
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
      // Real D1 allows all()/first()/run() directly on prepare() (bind optional).
      const unbound = bound();
      return { bind: bound, batch: async () => [] as unknown[], all: unbound.all, first: unbound.first, run: unbound.run };
    },
    batch: async () => [] as unknown[],
  };
  return { DB: db, ADMIN_SECRET: 'x' } as unknown as Env;
}

afterEach(() => {
  vi.useRealTimers();
});

function seasonRow(over: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  return {
    id: 'season-1',
    starts_at: now - 60_000,
    ends_at: now + 3_600_000,
    status: 'open',
    ...over,
  };
}

function transitionEnv(
  seasons: unknown[],
  opts: { entries?: unknown[]; snaps?: (params: unknown[]) => unknown[] } = {},
): { env: Env; runs: string[] } {
  const runs: string[] = [];
  const entries = opts.entries ?? [];
  const handlers: Handler[] = [
    {
      match: (s) => s.includes('FROM seasons') && s.includes('league_id IS NULL'),
      all: seasons,
    },
    {
      match: (s) => s.startsWith('UPDATE seasons SET status'),
      onRun: (sql) => runs.push(sql),
    },
    {
      match: (s) => s.includes('FROM season_entries WHERE season_id'),
      all: entries,
    },
    {
      match: (s) => s.includes('FROM equity_snapshots WHERE entry_id'),
      all: opts.snaps ?? [],
    },
    { match: (s) => s.includes('INSERT INTO scores'), onRun: (sql) => runs.push('INSERT scores') },
    { match: (s) => s.includes('UPDATE scores SET rank'), onRun: () => runs.push('UPDATE scores rank') },
  ];
  return { env: mockDb(handlers), runs };
}

describe('handleSeasonTransitions', () => {
  it('opens a season (open -> live) once starts_at has passed', async () => {
    const { env, runs } = transitionEnv([seasonRow({ status: 'open', starts_at: Date.now() - 1_000 })]);
    await handleSeasonTransitions(env);
    expect(runs.some((s) => s.includes("status = 'live'"))).toBe(true);
    expect(runs.some((s) => s.includes("status = 'settled'"))).toBe(false);
  });

  it('does not open a season before starts_at', async () => {
    const { env, runs } = transitionEnv([seasonRow({ status: 'open', starts_at: Date.now() + 3_600_000 })]);
    await handleSeasonTransitions(env);
    expect(runs).toEqual([]);
  });

  it('settles a live season (live -> closed -> settled) once ends_at has passed', async () => {
    const { env, runs } = transitionEnv(
      [seasonRow({ status: 'live', starts_at: Date.now() - 7_200_000, ends_at: Date.now() - 1_000 })],
      {
        entries: [{ id: 'e1', starting_capital: 10000 }],
        snaps: () => [
          { ts: Date.now() - 600_000, equity: 10000 },
          { ts: Date.now() - 300_000, equity: 10100 },
        ],
      },
    );
    await handleSeasonTransitions(env);
    expect(runs.some((s) => s.includes("status = 'closed'"))).toBe(true);
    expect(runs.some((s) => s.includes('INSERT scores'))).toBe(true);
    expect(runs.some((s) => s.includes("status = 'settled'"))).toBe(true);
  });

  it('does not settle a live season before ends_at', async () => {
    const { env, runs } = transitionEnv([
      seasonRow({ status: 'live', starts_at: Date.now() - 7_200_000, ends_at: Date.now() + 3_600_000 }),
    ]);
    await handleSeasonTransitions(env);
    expect(runs).toEqual([]);
  });

  it('is idempotent: a repeat tick after settling finds no eligible seasons', async () => {
    // First tick settles; the DB then returns no open/live official seasons.
    let calls = 0;
    const runs: string[] = [];
    const handlers: Handler[] = [
      {
        match: (s) => s.includes('FROM seasons') && s.includes('league_id IS NULL'),
        all: () => {
          calls += 1;
          return calls === 1
            ? [seasonRow({ status: 'live', starts_at: 1, ends_at: Date.now() - 1_000 })]
            : [];
        },
      },
      { match: (s) => s.startsWith('UPDATE seasons SET status'), onRun: (sql) => runs.push(sql) },
      { match: (s) => s.includes('FROM season_entries WHERE season_id'), all: [] },
      { match: (s) => s.includes('FROM equity_snapshots WHERE entry_id'), all: [] },
    ];
    const env = mockDb(handlers);
    await handleSeasonTransitions(env);
    const afterFirst = runs.length;
    await handleSeasonTransitions(env);
    expect(runs.length).toBe(afterFirst); // no new writes on the second tick
    expect(runs.some((s) => s.includes("status = 'settled'"))).toBe(true);
  });

  it('only queries official seasons (league_id IS NULL)', async () => {
    let seenSql = '';
    const handlers: Handler[] = [
      {
        match: (s) => s.includes('FROM seasons'),
        all: () => [],
      },
    ];
    const db = {
      prepare(sql: string) {
        if (sql.includes('FROM seasons')) seenSql = sql;
        const h = handlers.find((x) => x.match(sql)) ?? { match: () => true, all: [] as unknown[] };
        const bound = (...p: unknown[]) => ({
          all: async () => ({
            results: typeof h.all === 'function' ? (h.all as (x: unknown[]) => unknown[])(p) : (h.all ?? []),
          }),
          first: async () => null,
          run: async () => ({ success: true }),
        });
        const unbound = bound();
        return { bind: bound, batch: async () => [] as unknown[], all: unbound.all, first: unbound.first, run: unbound.run };
      },
      batch: async () => [] as unknown[],
    };
    const env = { DB: db, ADMIN_SECRET: 'x' } as unknown as Env;
    await handleSeasonTransitions(env);
    expect(seenSql).toContain('league_id IS NULL');
    expect(seenSql).toContain("status IN ('open', 'live')");
  });
});
