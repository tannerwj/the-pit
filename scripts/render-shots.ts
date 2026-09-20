// Render the three spectator pages to /tmp for visual testing (mock D1, no network).
import { writeFileSync } from 'fs';
import { homePage, leaderboardPage, pairPage } from './src/pages';

function mockDb(handlers: any[]): any {
  const db = {
    prepare(sql: string) {
      const h = handlers.find((x: any) => x.match(sql));
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
  return { DB: db, ADMIN_SECRET: 'x' };
}

const LB_ROWS = [
  { entry_id: 'abcd1111-uuid', agent_name: 'Speedy', alpha_score: 74.45, total_return: 0.3, sharpe: 1.8, max_drawdown: 0.05, win_rate: 0.62, profit_factor: 1.5, trades: 12, equity: 13000, rank: 1 },
  { entry_id: 'efgh2222-uuid', agent_name: 'Yolo', alpha_score: 71.43, total_return: 2.0, sharpe: 0.9, max_drawdown: 0.6, win_rate: 0.5, profit_factor: 2.2, trades: 3, equity: 30000, rank: 2 },
  { entry_id: 'ijkl3333-uuid', agent_name: 'Calm', alpha_score: 68.12, total_return: 0.12, sharpe: 1.2, max_drawdown: 0.08, win_rate: 0.55, profit_factor: 1.3, trades: 20, equity: 11200, rank: 3 },
  { entry_id: 'mnop4444-uuid', agent_name: 'Degen', alpha_score: 41.02, total_return: -0.2, sharpe: -0.5, max_drawdown: 0.35, win_rate: 0.4, profit_factor: 0.8, trades: 45, equity: 8000, rank: 4 },
];

const SEASON = { id: 'season-1', name: 'Season One', pair: 'BTC/USD', starts_at: Date.now() - 86400000, ends_at: Date.now() + 12 * 86400000 + 3600000, status: 'live' };

const handlers = [
  { match: (s: string) => s.includes('LEFT JOIN scores'), all: LB_ROWS },
  { match: (s: string) => s.includes("FROM seasons WHERE status = 'live'"), first: SEASON },
  { match: (s: string) => s.includes("status='scheduled'"), first: null },
  { match: (s: string) => s.includes('FROM seasons WHERE id = ?'), first: SEASON },
  { match: (s: string) => s.includes('FROM seasons ORDER BY'), all: [SEASON] },
  { match: (s: string) => s.includes('ORDER BY ts DESC LIMIT 1'), first: { bid: 81290, ask: 81292, ts: Date.now() - 30000 } },
  { match: (s: string) => s.includes('MAX((bid+ask)/2.0)'), first: { hi: 83000, lo: 79000, n: 1440 } },
  { match: (s: string) => s.includes('ORDER BY ts ASC LIMIT 1'), first: { m: 80000 } },
  { match: (s: string) => s.includes("FROM season_entries WHERE season_id = ? AND status = 'active'"), first: { n: 4 } },
  { match: (s: string) => s.includes('o.filled_at >='), first: { n: 42 } },
  { match: (s: string) => s.includes('COUNT(CASE WHEN p.qty'), first: { longs: 3, shorts: 1, net_qty: 0.5 } },
];

async function main() {
  const env = mockDb(handlers);
  const pages: [string, Response][] = [
    ['pit-home.html', await homePage(env)],
    ['pit-lb.html', await leaderboardPage(env, 'season-1')],
    ['pit-pair.html', await pairPage(env, 'BTC-USD')],
  ];
  for (const [name, res] of pages) {
    writeFileSync('/tmp/' + name, await res.text());
    console.log('wrote /tmp/' + name);
  }
}
main();
