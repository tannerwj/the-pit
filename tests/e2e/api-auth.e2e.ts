import { describe, expect, test } from 'e2e';
import { api, errCode } from './support/prod.js';

// Auth gating probes against production. Every request here is rejected
// before any write can happen: no API key, no session, no mutation.
describe('API auth gating', { platforms: ['node'], tags: ['api'] }, () => {
  const cases: Array<[string, string, RequestInit?]> = [
    ['POST', '/api/v1/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
    ['GET', '/api/v1/orders', {}],
    ['GET', '/api/v1/portfolio', {}],
    ['POST', '/api/v1/seasons/S1/enter', { method: 'POST' }],
    ['GET', '/api/v1/entries/e1/journal', {}],
    ['POST', '/api/v1/backtest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
  ];

  for (const [method, path, init] of cases) {
    test(`${method} ${path} without a key returns 401 unauthorized`, async () => {
      const res = await api(path, init);
      expect(res.status).toBe(401);
      expect(await errCode(res)).toBe('unauthorized');
    });
  }

  test('invalid API key returns 401 unauthorized', async () => {
    const res = await api('/api/v1/orders', { headers: { 'X-API-Key': 'pit_invalid_key' } });
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe('unauthorized');
  });

  test('admin endpoints without a secret return 403 forbidden', async () => {
    for (const path of ['/api/v1/admin/seasons', '/api/v1/admin/entries/e1/journal']) {
      const res = await api(path);
      expect(res.status).toBe(403);
      expect(await errCode(res)).toBe('forbidden');
    }
  });
});
