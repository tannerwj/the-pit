import type { Env } from '../lib/types';
import { json, err } from '../lib/auth';
import { q, q1 } from '../lib/db';

// URL pairs look like BTC-USD; the DB stores them as BTC/USD.
function urlPairToDb(pair: string): string {
  return decodeURIComponent(pair).replace(/-/g, '/').toUpperCase();
}

// GET /api/v1/market/:pair/quote (public)
export async function getQuote(
  _req: Request,
  env: Env,
  pair: string,
): Promise<Response> {
  const dbPair = urlPairToDb(pair);
  const row = await q1<{ bid: number; ask: number; ts: number; source: string }>(
    env.DB,
    'SELECT bid, ask, ts, source FROM quotes WHERE pair = ? ORDER BY ts DESC LIMIT 1',
    dbPair,
  );
  if (!row) {
    return err('unknown_pair', `No quote data for pair ${dbPair}`, 404);
  }
  return json({
    pair: dbPair,
    bid: row.bid,
    ask: row.ask,
    mid: (row.bid + row.ask) / 2,
    ts: row.ts,
    source: row.source,
  });
}

const BUCKET_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '1h': 3_600_000,
};

// GET /api/v1/market/:pair/candles?resolution=1m|5m|1h&from=&to= (public)
export async function getCandles(
  req: Request,
  env: Env,
  pair: string,
): Promise<Response> {
  const dbPair = urlPairToDb(pair);
  const params = new URL(req.url).searchParams;
  const resolution = params.get('resolution') ?? '1m';
  const bucketMs = BUCKET_MS[resolution];
  if (!bucketMs) {
    return err(
      'bad_resolution',
      'resolution must be one of 1m, 5m, 1h',
      422,
    );
  }
  const toParam = params.get('to');
  const fromParam = params.get('from');
  const to = toParam !== null ? Number(toParam) : Date.now();
  const from = fromParam !== null ? Number(fromParam) : to - 86_400_000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return err('bad_range', 'Invalid from/to timestamps', 422);
  }

  const rows = await q<{ ts: number; bid: number; ask: number }>(
    env.DB,
    `SELECT ts, bid, ask FROM quotes
     WHERE pair = ? AND ts >= ? AND ts <= ?
     ORDER BY ts ASC`,
    dbPair,
    Math.floor(from),
    Math.floor(to),
  );

  const buckets = new Map<number, { o: number; h: number; l: number; c: number }>();
  for (const r of rows) {
    const mid = (r.bid + r.ask) / 2;
    const t = Math.floor(r.ts / bucketMs) * bucketMs;
    const b = buckets.get(t);
    if (!b) {
      buckets.set(t, { o: mid, h: mid, l: mid, c: mid });
    } else {
      if (mid > b.h) b.h = mid;
      if (mid < b.l) b.l = mid;
      b.c = mid;
    }
  }
  const candles = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, c]) => ({ t, o: c.o, h: c.h, l: c.l, c: c.c }));

  return json({ pair: dbPair, resolution, candles });
}
