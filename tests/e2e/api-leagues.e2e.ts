import { describe, expect, test } from 'e2e';
import { api, errCode } from './support/prod.js';

// Read-only fantasy league browser.
describe('leagues API', { platforms: ['node'], tags: ['api'] }, () => {
  test('leagues list returns an array', async () => {
    const res = await api('/api/v1/leagues');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { leagues: unknown[] };
    expect(Array.isArray(body.leagues)).toBe(true);
  });

  test('unknown league slug returns 404 league_not_found', async () => {
    const res = await api('/api/v1/leagues/definitely-not-a-real-league');
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe('league_not_found');
  });

  test('league creation without a key returns 401 (never writes)', async () => {
    const res = await api('/api/v1/leagues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-probe', slug: 'e2e-probe' }),
    });
    expect(res.status).toBe(401);
  });
});
