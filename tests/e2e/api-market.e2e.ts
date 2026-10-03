import { describe, expect, test } from 'e2e';
import { api, errCode, PAIRS } from './support/prod.js';

// Read-only market data: quotes, candles, trades for all 5 pairs.
describe('market data API', { platforms: ['node'], tags: ['api'] }, () => {
  for (const pair of PAIRS) {
    test(`quote for ${pair} returns a fresh bid/ask`, async () => {
      const res = await api(`/api/v1/market/${pair}/quote`);
      expect(res.status).toBe(200);
      const q = (await res.json()) as {
        pair: string;
        bid: number;
        ask: number;
        mid: number;
        ts: number;
        source: string;
      };
      expect(q.pair).toBe(pair.replace('-', '/'));
      expect(q.bid).toBeGreaterThan(0);
      expect(q.ask).toBeGreaterThanOrEqual(q.bid);
      expect(q.mid).toBeGreaterThan(0);
      expect(q.source).toBe('coinbase');
      // Quote must be fresh: younger than 5 minutes.
      expect(Date.now() - q.ts).toBeLessThan(5 * 60 * 1000);
    });
  }

  test('candles return OHLCV buckets', async () => {
    const res = await api('/api/v1/market/BTC-USD/candles?resolution=1m&limit=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pair: string;
      resolution: string;
      candles: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
    };
    expect(body.resolution).toBe('1m');
    expect(body.candles.length).toBeGreaterThan(0);
    const c = body.candles[0];
    expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
    expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
    expect(c.t % 60000).toBe(0); // aligned to the minute
  });

  test('trades endpoint returns a list', async () => {
    const res = await api('/api/v1/market/BTC-USD/trades?limit=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pair: string; trades: unknown[] };
    expect(Array.isArray(body.trades)).toBe(true);
  });

  test('unknown pair returns 404 unknown_pair', async () => {
    const res = await api('/api/v1/market/FAKE-USD/quote');
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe('unknown_pair');
  });
});
