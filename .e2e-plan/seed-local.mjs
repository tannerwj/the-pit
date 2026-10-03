// seed-local.mjs — seeds a LOCAL `wrangler dev` of The Pit for e2e write-flow tests.
//
// Prerequisites (see .e2e-plan/local-env.md):
//   1. `npx wrangler dev --port 8788 --persist-to /tmp/the-pit-e2e-d1 \
//        --var ADMIN_SECRET:e2e-local-admin-secret` running from ~/workspace/the-pit
//   2. `npx wrangler d1 migrations apply the-pit --local --persist-to /tmp/the-pit-e2e-d1`
//
// What it does, in order:
//   - creates an admin season (status open -> flipped to `live` via the open transition)
//   - registers a test agent and captures its API key
//   - enters the season with that agent
//   - inserts a fresh BTC/USD quote row directly into the local D1 (market
//     orders need a quote fresher than 120s; this avoids any Coinbase fetch)
//   - runs the verification battery: valid market order -> 201; 2-char
//     rationale -> 422 rationale_required; journal with owner key -> 200;
//     journal with another agent's key -> 403 forbidden; portfolio -> 200
//
// Usage:
//   E2E_ADMIN_SECRET=e2e-local-admin-secret E2E_LOCAL_URL=http://127.0.0.1:8788 \
//     node .e2e-plan/seed-local.mjs
// On success prints a JSON blob with E2E_LOCAL_URL, admin_secret, api_key,
// season_id and entry_id, and exits 0. On failure exits non-zero with the
// failing step on stderr.
//
// Plain node (v24): uses only global fetch and child_process.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = process.env.E2E_LOCAL_URL ?? 'http://127.0.0.1:8788';
const ADMIN_SECRET = process.env.E2E_ADMIN_SECRET ?? 'e2e-local-admin-secret';
const PERSIST_TO = process.env.E2E_PERSIST_TO ?? '/tmp/the-pit-e2e-d1';
// Repo root: this file lives in ~/workspace/the-pit/.e2e-plan/
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fail(step, detail) {
  console.error(`FAIL ${step}: ${detail}`);
  process.exit(1);
}

function assertStatus(step, res, want) {
  if (res.status !== want) {
    const body = res.text ?? '';
    fail(step, `expected ${want}, got ${res.status}: ${body.slice(0, 500)}`);
  }
}

async function call(step, want, url, { method = 'GET', headers = {}, body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    fail(step, `fetch error: ${e.message} (is wrangler dev running at ${BASE}?)`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  const out = { status: res.status, text, json };
  assertStatus(step, out, want);
  return out;
}

// Direct D1 write against the SAME local database the dev server uses.
// wrangler d1 execute --local resolves the DB via wrangler.toml + --persist-to.
function d1(cmd) {
  try {
    return execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'the-pit', '--local', '--persist-to', PERSIST_TO, '--command', cmd],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    fail('d1', e.stderr?.toString().slice(0, 500) ?? e.message);
  }
}

const admin = { 'X-Admin-Secret': ADMIN_SECRET };

// 1. Create the season (admin). Generous window: started an hour ago, ends in 30 days.
const now = Date.now();
const seasonRes = await call('create-season', 201, `${BASE}/api/v1/admin/seasons`, {
  method: 'POST',
  headers: admin,
  body: {
    name: 'E2E Local Season',
    starts_at: now - 3_600_000,
    ends_at: now + 30 * 86_400_000,
    pairs: ['BTC/USD'],
    starting_capital: 10000,
    max_leverage: 3,
    allow_short: true,
  },
});
const seasonId = seasonRes.json.season.id;

// 2. Flip open -> live (the `open` admin action auto-advances an open season to live).
await call('season-live', 200, `${BASE}/api/v1/admin/seasons/${seasonId}/open`, {
  method: 'POST',
  headers: admin,
});

// 3. Register the test agent; capture the API key (shown exactly once).
const agentRes = await call('register-agent', 201, `${BASE}/api/v1/agents/register`, {
  method: 'POST',
  body: { email: 'e2e-agent@local.test', name: 'e2e-agent' },
});
const apiKey = agentRes.json.api_key;
if (typeof apiKey !== 'string' || !apiKey.startsWith('pit_')) {
  fail('register-agent', `unexpected api_key shape: ${JSON.stringify(apiKey)}`);
}
const agent = { 'X-API-Key': apiKey };

// 4. Enter the season.
const entryRes = await call('enter-season', 201, `${BASE}/api/v1/seasons/${seasonId}/enter`, {
  method: 'POST',
  headers: agent,
  body: {},
});
const entryId = entryRes.json.entry.id;

// 5. Insert a fresh quote (market orders need a quote < 120s old; direct D1
//    avoids depending on the Coinbase inline fetch in sandboxed environments).
const ts = Date.now();
d1(`INSERT INTO quotes (pair, ts, bid, ask, source) VALUES ('BTC/USD', ${ts}, 67000, 67010, 'e2e-seed')`);

// Sanity: the quote endpoint should see it.
await call('quote-sanity', 200, `${BASE}/api/v1/market/BTC-USD/quote`);

// 6. Verification battery.
const orderBody = {
  season_id: seasonId,
  pair: 'BTC/USD',
  side: 'buy',
  qty: 0.01,
  type: 'market',
  rationale: 'E2E verification order: testing that the local stack fills market orders.',
};
const okOrder = await call('order-valid', 201, `${BASE}/api/v1/orders`, {
  method: 'POST',
  headers: agent,
  body: orderBody,
});
if (okOrder.json.order?.status !== 'filled') {
  fail('order-valid', `expected filled market order, got: ${okOrder.text.slice(0, 300)}`);
}

// 2-char rationale -> 422 rationale_required (validated before anything else).
const badOrder = await call(
  'order-short-rationale',
  422,
  `${BASE}/api/v1/orders`,
  { method: 'POST', headers: agent, body: { ...orderBody, rationale: 'ab' } },
);
if (badOrder.json.error?.code !== 'rationale_required') {
  fail('order-short-rationale', `expected code rationale_required, got: ${badOrder.text.slice(0, 300)}`);
}

// Journal: owner key -> 200, other agent's key -> 403 forbidden.
await call('journal-owner', 200, `${BASE}/api/v1/entries/${entryId}/journal`, { headers: agent });

const otherRes = await call('register-agent-2', 201, `${BASE}/api/v1/agents/register`, {
  method: 'POST',
  body: { email: 'e2e-other@local.test', name: 'e2e-other' },
});
const otherKey = otherRes.json.api_key;
const forbidden = await call('journal-other-agent', 403, `${BASE}/api/v1/entries/${entryId}/journal`, {
  headers: { 'X-API-Key': otherKey },
});
if (forbidden.json.error?.code !== 'forbidden') {
  fail('journal-other-agent', `expected code forbidden, got: ${forbidden.text.slice(0, 300)}`);
}

// Portfolio: owner -> 200 and reflects the filled order.
const pf = await call('portfolio', 200, `${BASE}/api/v1/portfolio?season_id=${seasonId}`, { headers: agent });
if (!Array.isArray(pf.json.positions)) {
  fail('portfolio', `unexpected portfolio shape: ${pf.text.slice(0, 300)}`);
}

console.log(
  JSON.stringify(
    {
      E2E_LOCAL_URL: BASE,
      admin_secret: ADMIN_SECRET,
      api_key: apiKey,
      other_api_key: otherKey,
      season_id: seasonId,
      entry_id: entryId,
      order_id: okOrder.json.order.id,
      note: 'seed + verification battery passed (order 201, rationale 422 rationale_required, journal 200 owner / 403 other, portfolio 200)',
    },
    null,
    2,
  ),
);
