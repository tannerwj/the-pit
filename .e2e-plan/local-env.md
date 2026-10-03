# The Pit — local e2e test environment

Read-only against production: everything here runs LOCAL only. Never deploy,
never pass `--remote`, never touch the production worker or prod D1.

## Boot (from a zero-state scratch DB)

Terminal 1 — dev server (run from the repo root):

```bash
cd ~/workspace/the-pit
rm -rf /tmp/the-pit-e2e-d1                                  # fresh scratch DB
npx wrangler dev --port 8788 \
  --persist-to /tmp/the-pit-e2e-d1 \
  --var ADMIN_SECRET:e2e-local-admin-secret
```

Terminal 2 — apply migrations to the local D1:

```bash
cd ~/workspace/the-pit
npx wrangler d1 migrations apply the-pit --local --persist-to /tmp/the-pit-e2e-d1
```

Then seed + verify:

```bash
E2E_ADMIN_SECRET=e2e-local-admin-secret \
E2E_LOCAL_URL=http://127.0.0.1:8788 \
node .e2e-plan/seed-local.mjs
```

Expected: the script exits 0 and prints a JSON blob with `E2E_LOCAL_URL`,
the test agent `api_key`, `season_id`, `entry_id`, `order_id`, and the note
"seed + verification battery passed".

## Resetting the scratch DB

```bash
rm -rf /tmp/the-pit-e2e-d1   # with the dev server stopped (or it will recreate)
```

Nothing about the scratch DB lives in the repo worktree: `--persist-to`
keeps all miniflare state under `/tmp/the-pit-e2e-d1`. Re-run the three boot
steps to start over. The seed script is also re-runnable on a dirty DB
(season creation and agent registration are not unique-keyed).

## Admin-secret mechanism

- Admin routes live under `POST /api/v1/admin/...`, gated by
  `requireAdmin()` in `src/lib/auth.ts`: it compares the `X-Admin-Secret`
  request header to `env.ADMIN_SECRET` with a timing-safe equality check.
- **There is no dev default.** `env.ADMIN_SECRET` falls back to `''`, and
  `requireAdmin` denies only a _missing_ header — so locally you must pass
  the secret explicitly: `--var ADMIN_SECRET:<value>` on `wrangler dev`
  (verified working; shown as `env.ADMIN_SECRET ("(hidden)")` in the boot
  bindings list). All admin calls in the seed script send
  `X-Admin-Secret: <value>`.
- Admin endpoints used here: `POST /api/v1/admin/seasons` (creates status
  `open`) and `POST /api/v1/admin/seasons/:id/open` (the `open` action
  auto-advances an `open` season to `live`; valid actions are
  `open | close | settle`).

## Seed script (`seed-local.mjs`)

Plain node v24, no dependencies beyond what's installed (uses global `fetch`
and `child_process` to shell out to `npx wrangler d1 execute --local
--persist-to ...` for the quote insert). Order of operations:

1. `POST /api/v1/admin/seasons` — `{name, starts_at, ends_at,
pairs: ['BTC/USD']}` → 201, captures `season.id`. Season window:
   started 1h ago, ends in 30d.
2. `POST /api/v1/admin/seasons/:id/open` → 200, status becomes `live`
   (orders require `season.status === 'live'`).
3. `POST /api/v1/agents/register` (public) → 201, captures `api_key`
   (returned once; stored as sha256 in DB, so only this value works).
4. `POST /api/v1/seasons/:id/enter` with `X-API-Key` → 201, captures
   `entry.id` (entry gets $10k starting cash).
5. Direct D1 insert: `INSERT INTO quotes (pair, ts, bid, ask, source)
VALUES ('BTC/USD', <now>, 67000, 67010, 'e2e-seed')`. There is no
   admin quote-ingest endpoint; this is the simplest reliable path. The
   quote must be fresher than 120s (`QUOTE_TTL_MS` in
   `src/routes/orders.ts`) or a market order falls through to an inline
   Coinbase fetch.
6. Verification battery (all asserted in-script):
   - `POST /api/v1/orders` market buy 0.01 BTC w/ valid rationale → **201**,
     `order.status === 'filled'`
   - same order with `rationale: 'ab'` → **422** `rationale_required`
     (validated before anything else)
   - `GET /api/v1/entries/:id/journal` with owner key → **200**;
     with a second agent's key → **403** `forbidden`
   - `GET /api/v1/portfolio?season_id=...` with owner key → **200**,
     `positions` is an array
7. Prints the JSON blob (`E2E_LOCAL_URL`, `admin_secret`, `api_key`,
   `other_api_key`, `season_id`, `entry_id`, `order_id`).

Env overrides: `E2E_LOCAL_URL` (default `http://127.0.0.1:8788`),
`E2E_ADMIN_SECRET` (default `e2e-local-admin-secret`),
`E2E_PERSIST_TO` (default `/tmp/the-pit-e2e-d1`).

## Quirks hit while building this

1. **Port 8787 is taken.** Another session's family-hub `wrangler dev`
   occupies 8787, so this environment uses **8788**. The task asked for
   8787; don't grab it while family-hub is there. If 8787 is free on a
   later run, the port is only a CLI flag + `E2E_LOCAL_URL` — swap freely.
2. **Migrations are NOT auto-applied by `wrangler dev`** on a fresh local
   DB (confirmed: `GET /api/v1/seasons` → `no such table: seasons` until
   the apply). `npx wrangler d1 migrations apply the-pit --local
--persist-to /tmp/the-pit-e2e-d1` applies 0001–0004 and is idempotent
   (tracked in the local `d1_migrations` table).
3. **`--persist-to` is supported by both `wrangler dev` and
   `wrangler d1 execute`** (wrangler 4.135.0), so dev server and D1 CLI
   share the same isolated DB. Reset = delete the dir.
4. **Cron triggers do not fire under `wrangler dev`** (boot prints the
   warning). Quote ingest, equity snapshots, and scoring won't run
   locally; trigger manually if needed with
   `curl "http://localhost:8788/cdn-cgi/local/scheduled"`. For e2e order
   tests this is irrelevant — the fresh quote row covers the market-fill
   path.
5. **Error envelope shape** is `{error: {code, message}}` (see `err()` in
   `src/lib/auth.ts`), not a top-level `code`. The seed script asserts on
   `json.error.code`.
6. **Market orders need fresh quotes; limit orders don't.** The seed uses a
   market order with a fresh seeded quote. If you ever see 503
   `no_market_data`, the seeded quote went stale (>120s) — re-insert a
   fresh one.
7. **Never `pkill -f "wrangler dev"`** — it can match the shell running
   it. Stop this dev server by killing the session that started it (or
   `pkill -f "[w]rangler dev --port 8788"`).
8. Chromium in this sandbox cannot reach localhost; the whole battery is
   plain node `fetch` against `127.0.0.1` — keep it that way.
