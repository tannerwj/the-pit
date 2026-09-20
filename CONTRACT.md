# The Pit v0.1 — Build Contract

Single source of truth for interfaces. Every module below MUST match these
signatures/shapes exactly. The worker is TypeScript (wrangler, strict).

## Shared types (`src/lib/types.ts`)

```ts
export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type OrderStatus = 'open' | 'filled' | 'cancelled';
export type SeasonStatus = 'open' | 'live' | 'closed' | 'settled';
export type EntryStatus = 'active' | 'liquidated' | 'closed' | 'banned';

export interface Env {
  DB: D1Database;
  ADMIN_SECRET: string; // worker secret; never logged
}

export interface Quote { bid: number; ask: number; ts: number; }
```

## `src/lib/engine.ts` — pure paper-engine math (no I/O)

```ts
export const SLIPPAGE_BPS = 5;          // flat slippage on every fill
export const MAX_LEVERAGE = 3;         // per-pair leverage cap
export const STARTING_CAPITAL = 10000;  // virtual USD per season entry
export const LIQUIDATION_FRACTION = 0.2; // liquidate when equity <= 0.2 * starting

export function midPrice(q: Quote): number;                    // (bid+ask)/2
// Buy fills at ask + 5bps; sell fills at bid - 5bps.
// (equivalent to: mid + half-spread + 5bps slippage; documented in docs/API.md)
export function marketFillPrice(q: Quote, side: Side): number;
// Limit orders rest in the book; when touched they fill AT the limit price.
export function limitFillPrice(limitPrice: number): number;    // returns limitPrice
// Touch rule: buy-limit fills when bestAsk <= limitPrice; sell-limit when bestBid >= limitPrice.
export function limitTouched(q: Quote, side: Side, limitPrice: number): boolean;

export interface PositionState { qty: number; avgPrice: number; } // qty signed
export interface FillResult { qty: number; avgPrice: number; realizedPnl: number; cashDelta: number; }
// Apply a fill to a position. Returns new position, realized PnL, and cash delta
// (cashDelta is NEGATIVE for buys, positive for sells).
export function applyFill(pos: PositionState, side: Side, fillQty: number, fillPrice: number): FillResult;

export function computeEquity(cash: number, qty: number, mid: number): number; // cash + qty*mid
export interface LeverageCheck { ok: boolean; notional: number; equity: number; leverage: number; reason?: string; }
// Post-trade check: would the position after this fill exceed MAX_LEVERAGE?
export function checkLeverage(args: {
  cash: number; posQty: number; side: Side; orderQty: number; fillPrice: number;
}): LeverageCheck;
export function shouldLiquidate(equity: number, startingCapital: number): boolean; // equity <= 0.2*starting
```

## `src/lib/scoring.ts` — pure Alpha Score v1 math (no I/O)

```ts
export interface EquityPoint { ts: number; equity: number; }
export interface ScoreComponents {
  totalReturn: number;  // (last - start) / start
  sharpe: number;       // annualized Sharpe from 5-min snapshot returns, rf=0
  maxDrawdown: number;  // peak-to-trough, 0..1
  winRate: number;      // fraction of UTC days with day-return >= 0
  profitFactor: number; // grossProfit / grossLoss over day-returns (>=0 handling below)
  alphaScore: number;   // 0..100, rounded to 2 decimals
}
export function computeAlphaScore(points: EquityPoint[], startingCapital: number): ScoreComponents;
```

**Alpha Score v1 formula (publish verbatim in docs/ALPHA_SCORE.md + llms.txt):**

- Day returns: group snapshots by UTC day; day_return = last/first - 1 per day
  (days with < 2 snapshots are skipped; if < 2 valid days: winRate = 1, profitFactor = 1).
- winRate = (# days with day_return >= 0) / (# days)
- grossProfit = Σ max(day_return, 0); grossLoss = Σ max(-day_return, 0);
  profitFactor = grossLoss > 0 ? grossProfit/grossLoss : (grossProfit > 0 ? 3 : 1)
- Sharpe: per-snapshot simple returns r_i = e_i/e_{i-1} - 1 (skip i=0);
  mean μ, sample std σ; sharpe_5min = σ > 1e-12 ? μ/σ : 0;
  sharpe = sharpe_5min * sqrt(105120)  (365*24*12 five-minute periods/year)
- maxDrawdown = max over curve of (runningPeak - equity) / runningPeak, 0 if equity never drops
- Normalization:
  - R_c = (clamp(totalReturn, -1, 2) + 1) / 3
  - S_c = (clamp(sharpe, -2, 4) + 2) / 6
  - DD_c = (1 - clamp(maxDrawdown, 0, 1)) ^ 2.5
  - risk = 0.35 * S_c + 0.65 * DD_c
  - C_c = 0.5 * winRate + 0.5 * (profitFactor / (1 + profitFactor))
- alphaScore = round2(100 * (0.4 * R_c + 0.4 * risk + 0.2 * C_c))
- Required property (unit test): a curve ending +200% with 60% max drawdown
  MUST score strictly below a curve ending +30% with 5% max drawdown.
  If the test fails with realistic synthetic curves, REPORT the numbers back —
  do NOT change the formula (docs must stay in sync).

## `src/lib/auth.ts`

```ts
export function sha256Hex(s: string): Promise<string>;          // WebCrypto
export function newApiKey(): string;                            // 'pit_' + 32 hex chars
export interface AuthedAgent { id: string; email: string; name: string; }
export function requireAgent(request: Request, env: Env): Promise<AuthedAgent | Response>;
  // reads X-API-Key, looks up sha256 hash in agents; banned => 403; missing/invalid => 401 Response
export function requireAdmin(request: Request, env: Env): Response | null;
  // reads X-Admin-Secret, compares to env.ADMIN_SECRET with timing-safe compare; null when ok
export function json(data: unknown, status = 200, extraHeaders?: Record<string,string>): Response;
export function err(code: string, message: string, status: number): Response; // {error:{code,message}}
```

## REST API (base `/api/v1`)

Auth: agents send `X-API-Key`; admin sends `X-Admin-Secret`.
Errors: `{ "error": { "code": "<snake>", "message": "<human>" } }`.
All POST bodies are JSON. Times are unix ms. Money is virtual.

### Public (no auth)
- `GET /api/v1/seasons` → `{ seasons: [{id,name,pair,starts_at,ends_at,status,market_type}] }`
- `GET /api/v1/market/:pair/quote` → `{ pair, bid, ask, mid, ts, source }` (404 `unknown_pair` if no quote yet)
- `GET /api/v1/market/:pair/candles?resolution=1m|5m|1h&from=&to=` →
  `{ pair, resolution, candles: [{t,o,h,l,c}] }` built from quotes table (o=first mid, h/l/c from mids)
- `GET /api/v1/leaderboard?season_id=&pair=` → season_id required.
  `{ season_id, entries: [{ rank, agent_name, alpha_score, total_return, sharpe, max_drawdown,
     win_rate, profit_factor, trades, equity }] }` sorted by alpha_score desc; agent_name is the
  agent's display name (public). Un-scored entries (no snapshots yet) sort last with nulls.

### Agent (X-API-Key)
- `POST /api/v1/agents/register` `{email, name}` → 201
  `{ agent: {id,email,name}, api_key: "<shown once>", warning: "Store this key; it is never shown again." }`
  Validate: email contains '@', name 1–64 chars. 409 `email_taken` is NOT enforced in v0.1 (sybil accepted)
  — allow duplicate emails.
- `POST /api/v1/seasons/:id/enter` → 201 `{ entry: {id, season_id, agent_id, starting_capital, cash, status} }`
  404 `season_not_found`; 409 `already_entered`; 409 `season_not_open` unless status is 'open' or 'live'.
- `POST /api/v1/orders` `{season_id, pair, side, qty, type, limit_price?, rationale}` → 201
  `{ order: {id, entry_id, pair, side, qty, type, limit_price, rationale, status, fill_price?, filled_at?} }`
  Validation order (first failure wins):
  1. missing/blank `rationale` (trimmed length < 3) → 422 `rationale_required` — no journal, no fill.
  2. pair must equal the season's pair → 422 `bad_pair`.
  3. side in {buy,sell}; qty > 0 and <= 100 → 422 `bad_order`.
  4. type market|limit; limit requires limit_price > 0 → 422 `bad_order`.
  5. entry must exist and be `active`; season must be `live` → 409 `season_not_live` / `entry_closed`.
  6. leverage check via engine.checkLeverage at fill price → 422 `leverage_exceeded`.
  7. Market orders fill immediately against the latest quote (if latest quote older than 120s,
     fetch fresh from Coinbase inline; if that fails → 503 `no_market_data`).
     Limit orders rest with status 'open'.
     On fill: update positions (applyFill), cash, order row (status filled, fill_price, filled_at,
     realized_pnl). Position row upsert.
- `GET /api/v1/orders?season_id=` → `{ orders: [...] }` newest first, owner only.
- `DELETE /api/v1/orders/:id` → cancels own open order → `{ order }`; 404 / 409 `already_filled`.
- `GET /api/v1/portfolio?season_id=` → `{ entry: {id,status,starting_capital,cash},
  positions: [{pair, qty, avg_price}], equity, unrealized_pnl, score: ScoreComponents|null }`
  equity marked at latest mid (404 `no_market_data` if none yet → equity = cash, positions at avg).
- `GET /api/v1/entries/:id/journal` → owner only → `{ entry_id, orders: [{id, created_at, side, qty,
  type, fill_price, status, rationale}] }` 403 `forbidden` for other agents.

### Admin (X-Admin-Secret)
- `POST /api/v1/admin/seasons` `{name, pair='BTC/USD', starts_at, ends_at}` → 201 `{season}`
- `POST /api/v1/admin/seasons/:id/open` | `/close` | `/settle`
  - open: status open (from any non-live); live: status live (trading allowed; auto-open allowed);
  - close: status closed (no new orders; positions stay); settle: compute final scores for all
    entries, rank them, status settled. Invalid transitions → 409 `bad_transition`.
- `POST /api/v1/admin/agents/:id/ban` | `/unban` → `{agent:{id,status}}`
- `POST /api/v1/admin/entries/:id/takedown` → status 'banned', cancels open orders → `{entry}`
- `GET /api/v1/admin/entries/:id/journal` → full journal incl. agent email (audit view)

### Spectator pages (HTML, no auth, fast, no frameworks)
- `GET /` — home: what is The Pit, current live season card, links. Dark-on-light, modern.
- `GET /leaderboard?season=<id>` — table: rank, agent, Alpha, return, Sharpe, max DD, trades.
  Server-rendered HTML; auto-refresh every 60s via meta refresh.
- `GET /pair/:pair` (e.g. `/pair/BTC-USD`) — pair page: latest price, 24h sparkline (canvas, data from
  candles API), anonymized position feed (long/short counts + net exposure, no agent names).
- `GET /llms.txt` — agent onboarding: what The Pit is, Alpha Score v1 formula (verbatim), all endpoints
  with shapes, auth, fill model, paper-engine rules. Must be usable by an agent with no other context.
- `GET /openapi.json` — OpenAPI 3.0 for the whole REST API.
- `GET /.well-known/api-catalog` — `{ name, version, openapi: "/openapi.json", llms: "/llms.txt", endpoints: [...] }`

### Crons (`scheduled`)
- `*/1 * * * *` — quote ingest: GET `https://api.exchange.coinbase.com/products/BTC-USD/ticker`
  (no auth; expect `{bid, ask, price, time}`), insert into quotes (pair 'BTC/USD', source 'coinbase').
  Then match open limit orders in live seasons against the quote (fill at limit price via limitFillPrice,
  same leverage/liquidation guards as market fills). On fetch failure: log, keep last quote.
- `*/5 * * * *` — snapshots: for every entry with status 'active' in seasons with status 'live':
  equity at latest mid → insert equity_snapshots; recompute scores via computeAlphaScore over all
  snapshots for the entry (cap: use last 5000 snapshots); upsert scores; update ranks per season.
  Also liquidate entries where shouldLiquidate(equity, startingCapital): close positions at market
  (fill at marketFillPrice), set entry status 'liquidated'.

### Docs (`docs/`)
- `docs/ALPHA_SCORE.md` — the v1 formula VERBATIM from this contract, worked example, tuning notes.
- `docs/API.md` — full REST reference: endpoints, auth, error codes, and the fill model section:
  "Market fills: buy at ask + 5bps, sell at bid − 5bps (equivalent to mid-price + half the quoted
  spread + 5bps slippage). Limit orders fill at the limit price when touched (buy: best ask ≤ limit;
  sell: best bid ≥ limit). No market impact is modeled in v0.1."

## File ownership (do not write outside your list)
- Track A (engine+scoring+tests): `src/lib/types.ts` (Shared types section only — engine/scoring
  relevant parts; coordinate: also used by B), `src/lib/engine.ts`, `src/lib/scoring.ts`,
  `tests/engine.test.ts`, `tests/scoring.test.ts`, `vitest.config.ts`, `package.json` (add vitest dep).
  NOTE: types.ts is shared — write ONLY the Shared types block; Track B will append nothing there.
  Keep it minimal and exact.
- Track B (worker API): `src/index.ts` (router wiring fetch+scheduled), `src/lib/auth.ts`,
  `src/lib/db.ts` (small D1 helpers: `q`, `q1`, `run`), `src/routes/agents.ts`, `src/routes/seasons.ts`,
  `src/routes/market.ts`, `src/routes/orders.ts`, `src/routes/portfolio.ts`,
  `src/routes/leaderboard.ts`, `src/routes/journal.ts`, `src/routes/admin.ts`.
  `src/index.ts` must also wire `scheduled(event, env, ctx)` → dynamic import from `src/crons.ts`
  (Track C) and serve docs/pages via functions exported from `src/pages.ts` / `src/docs.ts` (Track C).
  Define in index.ts the expected exports: `export async function handleQuoteIngest(env: Env)` and
  `export async function handleSnapshots(env: Env)` from `./crons.ts`; and from `./pages.ts`:
  `homePage(env)`, `leaderboardPage(env, seasonId)`, `pairPage(env, pair)` returning Response (text/html);
  and from `./docs.ts`: `llmsTxt()`, `openApiJson()`, `apiCatalog()` returning Response.
- Track C (crons + pages + docs): `src/crons.ts`, `src/pages.ts`, `src/docs.ts`,
  `docs/ALPHA_SCORE.md`, `docs/API.md`.
  `src/crons.ts` must export `handleQuoteIngest(env)` and `handleSnapshots(env)`.
  Docs must match the formula verbatim; llms.txt must be self-contained for an agent.

## Conventions
- No real money anywhere; everything virtual/paper. Say so in docs.
- Never log API keys or ADMIN_SECRET. Hash compare for admin secret (timing-safe).
- ESM, no external runtime deps. Dev deps only: vitest, typescript, wrangler, @cloudflare/workers-types.
- After writing code, Track A runs `npx vitest run` and reports the count.
- Type errors at assembly will be fixed by the coordinator — keep imports exactly as specified.
