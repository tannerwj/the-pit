// e2e.config.ts — tester-army/e2e configuration for The Pit.
//
// Targets:
//   prod-ui   — live site UI (read-only). Season 1 is LIVE: every test here
//               must be read-only (GET pages; no orders, entries, or writes).
//   prod-api  — live site public API (read-only): fetch + expect, no browser.
//   local-api — write-flow API tests against a local `wrangler dev` + scratch
//               D1 (see .e2e-plan/local-env.md). URL from E2E_LOCAL_URL.
//
// Browser plumbing: in this sandbox Chromium cannot reach localhost and
// Playwright browser downloads stall, so E2E_CDP_URL points at a
// pre-launched /opt/meta-chromium/chrome (headless, --proxy-server to the
// local CONNECT forwarder for egress). In CI the variable is unset and the
// engine launches Playwright's own Chromium instead.
// scripts/e2e-sandbox.sh starts the proxy + Chromium around `e2e run`.
//
// All tests are deterministic: no `agent.*` steps, so no model is configured.

import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

const PROD_URL = process.env.E2E_PROD_URL ?? 'https://the-pit.twj.workers.dev';
const CDP_URL = process.env.E2E_CDP_URL;

export default {
  tests: 'tests/e2e/**/*.e2e.ts',
  workers: 1,
  timeout: 120_000,
  targets: [
    {
      name: 'prod-ui',
      engine: web(
        CDP_URL ? { connect: { cdpEndpoint: () => CDP_URL as string } } : {},
      ),
      app: { url: PROD_URL },
    },
    // Engine-less: API tests (fetch + expect) open no browser. Tests read
    // the base URL from the environment and select via `platforms`.
    { name: 'prod-api', platform: 'node' },
    { name: 'local-api', platform: 'local' },
  ],
} satisfies E2EConfig;
