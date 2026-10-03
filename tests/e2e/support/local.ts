// Helpers for local write-flow API tests (platform: 'local').
//
// These tests run against a LOCAL `wrangler dev` + scratch D1 — never
// production. The dev server must already be running (see
// .e2e-plan/local-env.md). The first call to localCtx() seeds a fresh
// season + agent by shelling out to .e2e-plan/seed-local.mjs (once per
// process) and caches the credentials.
import { execFileSync } from 'node:child_process';

export const LOCAL_URL =
  process.env.E2E_LOCAL_URL ?? 'http://127.0.0.1:8788';
const ADMIN_SECRET =
  process.env.E2E_ADMIN_SECRET ?? 'e2e-local-admin-secret';
const PERSIST_TO = process.env.E2E_PERSIST_TO ?? '/tmp/the-pit-e2e-d1';

export interface LocalCtx {
  admin: Record<string, string>;
  agent: Record<string, string>;
  otherAgent: Record<string, string>;
  season_id: string;
  entry_id: string;
}

let ctx: LocalCtx | null = null;

export function localCtx(): LocalCtx {
  if (ctx) return ctx;
  const out = execFileSync('node', ['.e2e-plan/seed-local.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      E2E_LOCAL_URL: LOCAL_URL,
      E2E_ADMIN_SECRET: ADMIN_SECRET,
      E2E_PERSIST_TO: PERSIST_TO,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const seed = JSON.parse(out) as {
    admin_secret: string;
    api_key: string;
    other_api_key: string;
    season_id: string;
    entry_id: string;
  };
  ctx = {
    admin: { 'X-Admin-Secret': seed.admin_secret },
    agent: { 'X-API-Key': seed.api_key },
    otherAgent: { 'X-API-Key': seed.other_api_key },
    season_id: seed.season_id,
    entry_id: seed.entry_id,
  };
  return ctx;
}

export function lapi(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(new URL(path, LOCAL_URL), init);
}

export function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return lapi(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export async function errCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? '';
}

// Market fills need a quote fresher than 120s. The seed inserts one, but a
// slow run can outlive it — refresh on demand.
export function refreshQuote(price = 67000): void {
  const ts = Date.now();
  execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'the-pit',
      '--local',
      '--persist-to',
      PERSIST_TO,
      '--command',
      `INSERT INTO quotes (pair, ts, bid, ask, source) VALUES ('BTC/USD', ${ts}, ${price}, ${price + 10}, 'e2e-test')`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

// Register a brand-new agent (clean slate: no positions, own entry).
export async function freshAgent(): Promise<{
  headers: Record<string, string>;
  entry_id: string;
}> {
  const c = localCtx();
  const name = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const reg = await post(
    '/api/v1/agents/register',
    { email: `${name}@local.test`, name },
  );
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status}`);
  const { api_key } = (await reg.json()) as { api_key: string };
  const headers = { 'X-API-Key': api_key };
  const enter = await post(`/api/v1/seasons/${c.season_id}/enter`, {}, headers);
  if (enter.status !== 201) throw new Error(`enter failed: ${enter.status}`);
  const { entry } = (await enter.json()) as { entry: { id: string } };
  return { headers, entry_id: entry.id };
}

export const RATIONALE =
  'E2E test order: validating the paper-trading order lifecycle.';
