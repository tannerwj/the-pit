// The Pit — spectator UI + new read-endpoint tests (mock D1, no network).
import { describe, it, expect } from 'vitest';
import { homePage, leaderboardPage, pairPage } from '../src/pages';
import { getEquityCurve, getRecentTrades } from '../src/routes/spectator';
import type { Env } from '../src/lib/types';

interface Handler {
  match: (sql: string) => boolean;
  all?: unknown[];
  first?: unknown;
}

function mockDb(handlers: Handler[]): Env {
  const db = {
    prepare(sql: string) {
      const h = handlers.find((x) => x.match(sql));
      const bound = (..._p: unknown[]) => ({
        all: async () => ({ results: h?.all ?? [] }),
        first: async () => h?.first ?? null,
        run: async () => ({ success: true }),
      });
      return {
        bind: bound,
        all: () => bound().all(),
        first: () => bound().first(),
        run: () => bound().run(),
      };
    },
  };
  return { DB: db, ADMIN_SECRET: 'x' } as unknown as Env;
}

const LIVE_SEASON = {
  id: 'season-1',
  name: 'Season One',
  pair: 'BTC/USD',
  starts_at: 1,
  ends_at: 2,
  status: 'live',
};

const LB_ROWS = [
  {
    entry_id: 'abcd1111-uuid',
    agent_name: 'Speedy',
    alpha_score: 74.45,
    total_return: 0.3,
    sharpe: 1.8,
    max_drawdown: 0.05,
    win_rate: 0.62,
    trades: 12,
    equity: 13000,
    rank: 1,
  },
  {
    entry_id: 'efgh2222-uuid',
    agent_name: 'Yolo',
    alpha_score: 71.43,
    total_return: 2.0,
    sharpe: 0.9,
    max_drawdown: 0.6,
    win_rate: 0.5,
    trades: 3,
    equity: 30000,
    rank: 2,
  },
];

function pageHandlers(extra: Handler[] = []): Handler[] {
  return [
    { match: (s) => s.includes('LEFT JOIN scores'), all: LB_ROWS },
    {
      match: (s) => s.includes("FROM seasons WHERE status = 'live'"),
      first: LIVE_SEASON,
    },
    {
      match: (s) => s.includes('FROM seasons WHERE id = ?'),
      first: LIVE_SEASON,
    },
    {
      match: (s) => s.includes('FROM seasons ORDER BY'),
      all: [LIVE_SEASON],
    },
    {
      match: (s) => s.includes('ORDER BY ts DESC LIMIT 1'),
      first: { bid: 81290, ask: 81292, ts: 1700000000000 },
    },
    {
      match: (s) => s.includes('MAX((bid+ask)/2.0)'),
      first: { hi: 83000, lo: 79000, n: 1440 },
    },
    {
      match: (s) => s.includes('ORDER BY ts ASC LIMIT 1'),
      first: { m: 80000 },
    },
    {
      match: (s) => s.includes("FROM season_entries WHERE season_id = ? AND status = 'active'"),
      first: { n: 2 },
    },
    { match: (s) => s.includes('o.filled_at >='), first: { n: 42 } },
    {
      match: (s) => s.includes('COUNT(CASE WHEN p.qty'),
      first: { longs: 3, shorts: 1, net_qty: 0.5 },
    },
    ...extra,
  ];
}

async function text(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toContain('text/html');
  return res.text();
}

describe('spectator pages', () => {
  it('home returns 200 with dark exchange markup', async () => {
    const html = await text(await homePage(mockDb(pageHandlers())));
    expect(html).toContain('THE&nbsp;PIT');
    expect(html).toContain('#0b0e11');
    expect(html).toContain('id="heroPrice"');
    expect(html).toContain('id="markets"');
    expect(html).toContain('id="ntPrice"');
    expect(html).toContain('pitPollQuote');
    expect(html).toContain('Agent #abcd'); // anonymized top-5
    expect(html).toContain('$81,291.00');
  });

  it('leaderboard returns 200 with sortable table + sparklines', async () => {
    const html = await text(
      await leaderboardPage(mockDb(pageHandlers()), 'season-1'),
    );
    expect(html).toContain('data-season="season-1"');
    expect(html).toContain('th class="sortable"');
    expect(html).toContain('canvas class="spark"');
    expect(html).toContain('data-entry="abcd1111-uuid"');
    expect(html).toContain('Alpha Score');
    expect(html).toContain('id="seasonSel"');
    // agent real names must not leak; anonymized labels shown
    expect(html).not.toContain('>Speedy<');
    expect(html).toContain('Agent #abcd');
  });

  it('leaderboard 404s on unknown season', async () => {
    const res = await leaderboardPage(
      mockDb([{ match: () => true, first: null, all: [] }]),
      'nope',
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Season not found');
  });

  it('pair page returns 200 with chart, quote card, tape, book', async () => {
    const html = await text(await pairPage(mockDb(pageHandlers()), 'BTC-USD'));
    expect(html).toContain('id="candles"');
    expect(html).toContain('data-pair="BTC-USD"');
    expect(html).toContain('id="trades"');
    expect(html).toContain('Book pressure');
    expect(html).toContain('id="qBid"');
    expect(html).toContain('id="qAsk"');
    expect(html).toContain('tfbtns');
    expect(html).toContain('/api/v1/market/');
    expect(html).toContain('/trades?limit=20');
  });
});

describe('spectator read endpoints', () => {
  it('getEquityCurve downsamples and 404s on unknown entry', async () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({
      t: 1000 + i,
      equity: 10000 + i * 10,
    }));
    const env = mockDb([
      {
        match: (s) => s.includes('FROM season_entries WHERE id = ?'),
        first: { id: 'e1' },
      },
      { match: (s) => s.includes('FROM equity_snapshots'), all: pts },
    ]);
    const req = new Request(
      'https://x/api/v1/entries/e1/equity?points=4',
    );
    const res = await getEquityCurve(req, env, 'e1');
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      entry_id: string;
      points: { t: number; equity: number }[];
    };
    expect(j.entry_id).toBe('e1');
    expect(j.points.length).toBe(5); // 4 sampled + last
    expect(j.points[0]).toEqual({ t: 1000, equity: 10000 });
    expect(j.points[j.points.length - 1]).toEqual({
      t: 1009,
      equity: 10090,
    });

    const env404 = mockDb([]);
    const res404 = await getEquityCurve(req, env404, 'missing');
    expect(res404.status).toBe(404);
  });

  it('getRecentTrades anonymizes and respects limit', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      entry_id: `abcdef${i}-uuid`,
      side: i % 2 ? 'sell' : 'buy',
      qty: 0.01,
      fill_price: 81000 + i,
      filled_at: 1700000000000 + i,
    }));
    let seenLimit = 0;
    const db = {
      prepare() {
        return {
          bind(...p: unknown[]) {
            seenLimit = p[p.length - 1] as number;
            return {
              all: async () => ({ results: rows.slice(0, seenLimit) }),
              first: async () => null,
              run: async () => ({ success: true }),
            };
          },
        };
      },
    };
    const env = { DB: db, ADMIN_SECRET: 'x' } as unknown as Env;
    const req = new Request(
      'https://x/api/v1/market/BTC-USD/trades?limit=5',
    );
    const res = await getRecentTrades(req, env, 'BTC-USD');
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      pair: string;
      trades: { agent: string; side: string }[];
    };
    expect(j.pair).toBe('BTC/USD');
    expect(j.trades.length).toBe(5);
    expect(j.trades[0].agent).toBe('Agent #abcd');
    expect(j.trades[0].agent).not.toContain('abcdef0-uuid');
  });
});
