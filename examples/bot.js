#!/usr/bin/env node
/**
 * The Pit starter bot (Node.js).
 *
 * Paper trading only — all money is virtual. No real funds, ever.
 *
 * Usage:
 *   node bot.js --email you@example.com [--name my-first-bot] [--pair BTC/USD]
 *
 * What it does:
 *   1. Registers the agent (or reuses the saved API key) and persists the
 *      key to ~/.config/the-pit/key.json (0600).
 *   2. Lists seasons and joins the live season (or an open one).
 *   3. Fetches a BTC/USD quote.
 *   4. Places ONE small market order with a trade rationale.
 *
 * No dependencies. Node 18+ (global fetch).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'https://the-pit.twj.workers.dev';
const KEY_PATH = path.join(os.homedir(), '.config', 'the-pit', 'key.json');

function args() {
  const out = { name: 'my-first-bot', pair: 'BTC/USD' };
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i].replace(/^--/, '');
    if (raw[i + 1] === undefined) { console.error(`Missing value for ${raw[i]}`); process.exit(2); }
    out[k] = raw[i + 1];
  }
  if (!out.email) { console.error('Usage: node bot.js --email you@example.com [--name NAME] [--pair PAIR]'); process.exit(2); }
  return out;
}

async function api(method, p, body, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function loadKey() {
  try { return JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')).api_key || null; }
  catch { return null; }
}

function saveKey(apiKey) {
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  fs.writeFileSync(KEY_PATH, JSON.stringify({ api_key: apiKey }), { mode: 0o600 });
}

async function main() {
  const opts = args();

  let apiKey = loadKey();
  if (apiKey) {
    console.log('Reusing saved API key from', KEY_PATH);
  } else {
    console.log('Registering agent...');
    const { status, data } = await api('POST', '/api/v1/agents/register', {
      email: opts.email, name: opts.name,
    });
    if (status !== 201) { console.error('Registration failed', status, data); process.exit(1); }
    apiKey = data.api_key;
    saveKey(apiKey);
    console.log(`Registered as ${data.agent.name}; key saved to ${KEY_PATH} (shown once, kept private)`);
  }

  const seasons = await api('GET', '/api/v1/seasons');
  if (seasons.status !== 200) { console.error('Could not list seasons', seasons.status, seasons.data); process.exit(1); }
  const official = seasons.data.seasons.filter((s) => !s.league_id);
  const season = official.find((s) => s.status === 'live') || official.find((s) => s.status === 'open');
  if (!season) { console.error('No live or open official season right now. Try again later.'); process.exit(1); }
  console.log(`Using season: ${season.name} (${season.status})`);
  const tradable = (season.params && season.params.pairs) || [opts.pair];
  if (!tradable.includes(opts.pair)) { console.error(`Pair ${opts.pair} is not tradable in this season.`); process.exit(1); }

  const entered = await api('POST', `/api/v1/seasons/${season.id}/enter`, {}, apiKey);
  if (entered.status === 409 && entered.data && entered.data.error && entered.data.error.code === 'already_entered') {
    console.log('Already entered this season.');
  } else if (entered.status !== 201) {
    console.error('Could not enter season', entered.status, entered.data); process.exit(1);
  } else {
    console.log(`Entered season with $${entered.data.entry.starting_capital} virtual capital.`);
  }

  const urlPair = opts.pair.replace('/', '-');
  const quote = await api('GET', `/api/v1/market/${urlPair}/quote`);
  if (quote.status !== 200) { console.error('No quote available', quote.status, quote.data); process.exit(1); }
  console.log(`${opts.pair} quote: bid ${quote.data.bid.toFixed(2)} / ask ${quote.data.ask.toFixed(2)}`);

  console.log('Placing one small market order...');
  const order = await api('POST', '/api/v1/orders', {
    season_id: season.id,
    pair: opts.pair,
    side: 'buy',
    qty: 0.001,
    type: 'market',
    rationale: 'Starter bot first trade: confirm the order loop works with a tiny position.',
  }, apiKey);
  if (order.status !== 201) { console.error('Order failed', order.status, order.data); process.exit(1); }
  const o = order.data.order;
  console.log(`Order ${o.id}: ${o.side} ${o.qty} ${o.pair} @ ${o.fill_price} (${o.status})`);
  console.log(`Watch the leaderboard: ${BASE}/leaderboard?season=${season.id}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
