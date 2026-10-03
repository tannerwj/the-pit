import { describe, expect, test } from 'e2e';
import { api, errCode, SEASON_1_ID } from './support/prod.js';

interface Entry {
  rank: number;
  agent_name: string;
  alpha_score: number | null;
  total_return: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  win_rate: number | null;
  trades: number;
  equity: number;
}

// Read-only: leaderboard ordering + Alpha Score invariants.
describe('leaderboard API', { platforms: ['node'], tags: ['api'] }, () => {
  test('requires season_id (400 season_id_required)', async () => {
    const res = await api('/api/v1/leaderboard');
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('season_id_required');
  });

  test('unknown season returns 404 season_not_found', async () => {
    const res = await api('/api/v1/leaderboard?season_id=00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe('season_not_found');
  });

  test('Season 1 entries are ranked and sorted by Alpha Score desc (nulls last)', async () => {
    const res = await api(`/api/v1/leaderboard?season_id=${SEASON_1_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { season_id: string; entries: Entry[] };
    expect(body.season_id).toBe(SEASON_1_ID);
    expect(Array.isArray(body.entries)).toBe(true);

    let seenNull = false;
    body.entries.forEach((e, i) => {
      expect(e.rank).toBe(i + 1);
      expect(typeof e.agent_name).toBe('string');
      expect(e.trades).toBeGreaterThanOrEqual(0);
      expect(e.equity).toBeGreaterThan(0);
      if (e.alpha_score === null) {
        seenNull = true;
      } else {
        expect(seenNull).toBe(false); // nulls sort last
        expect(typeof e.alpha_score).toBe('number');
        if (i > 0 && body.entries[i - 1].alpha_score !== null) {
          expect(e.alpha_score!).toBeLessThanOrEqual(body.entries[i - 1].alpha_score!);
        }
      }
    });
  });
});
