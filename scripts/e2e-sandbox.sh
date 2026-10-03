#!/usr/bin/env bash
# scripts/e2e-sandbox.sh — run the e2e suite inside this sandbox.
#
# Sandbox constraints: Chromium cannot reach localhost or the public internet
# directly, and Playwright browser downloads stall. UI tests therefore run
# through a Chromium that egresses via a local CONNECT forwarder, attached
# over CDP (see e2e.config.ts `connect.cdpEndpoint`).
#
# This wrapper ensures the plumbing is up, then runs `e2e run`:
#   1. Reuses Chromium on :9222 if it already serves CDP (the workspace-wide
#      shared infra at ~/workspace/e2e-infra/ keeps one running).
#   2. Otherwise starts the CONNECT forwarder (shared
#      ~/workspace/e2e-infra/fwdproxy.py preferred, vendored
#      scripts/proxy_fwd.py as fallback) and launches
#      /opt/meta-chromium/chrome headless with --proxy-server,
#      --ignore-certificate-errors (egress TLS interception) and CDP on :9222.
#   3. Runs `npx e2e run` with E2E_CDP_URL + E2E_TELEMETRY_DISABLED=1.
#
# In CI this script is not needed: E2E_CDP_URL is unset there and the engine
# launches Playwright's own Chromium.
#
# Usage: ./scripts/e2e-sandbox.sh [--target prod-ui] [e2e run args...]
# Env:   E2E_PROD_URL (default https://the-pit.twj.workers.dev)
#        E2E_LOCAL_URL (for --target local-api; start wrangler dev separately,
#                       see .e2e-plan/local-env.md)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

CDP_PORT=9222
SHARED_INFRA="$HOME/workspace/e2e-infra"
CHROME_BIN="${CHROME_BIN:-/opt/meta-chromium/chrome}"
STARTED_PROXY=""

port_open() {
  python3 -c "import socket,sys; socket.create_connection(('127.0.0.1', $1), timeout=2).close()" 2>/dev/null
}

start_forwarder() {
  # Prefer the shared forward proxy on 8888; fall back to the vendored one.
  if port_open 8888 || port_open 18080; then
    return 0
  fi
  if [[ -f "$SHARED_INFRA/fwdproxy.py" ]]; then
    nohup python3 "$SHARED_INFRA/fwdproxy.py" > /tmp/e2e-fwdproxy.log 2>&1 &
    STARTED_PROXY=$!
  else
    nohup python3 "$SCRIPT_DIR/proxy_fwd.py" > /tmp/e2e-fwdproxy.log 2>&1 &
    STARTED_PROXY=$!
  fi
  for _ in $(seq 1 20); do
    (port_open 8888 || port_open 18080) && break
    sleep 0.5
  done
  (port_open 8888 || port_open 18080) || { echo "forwarder did not come up" >&2; exit 1; }
}

proxy_url() {
  if port_open 8888; then echo "http://127.0.0.1:8888"; else echo "http://127.0.0.1:18080"; fi
}

cleanup() {
  # Only stop what we started; never touch the shared Chromium.
  [[ -n "$STARTED_PROXY" ]] && kill "$STARTED_PROXY" 2>/dev/null || true
  [[ -n "${CHROME_PID:-}" ]] && kill "$CHROME_PID" 2>/dev/null || true
}
trap cleanup EXIT

start_forwarder

if ! curl -s --max-time 3 "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null 2>&1; then
  PROFILE="$(mktemp -d /tmp/e2e-chrome.XXXXXX)"
  "$CHROME_BIN" \
    --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --remote-debugging-port="$CDP_PORT" \
    --proxy-server="$(proxy_url)" \
    --ignore-certificate-errors \
    --user-data-dir="$PROFILE" \
    --no-first-run --no-default-browser-check \
    about:blank > /tmp/e2e-chrome.log 2>&1 &
  CHROME_PID=$!
  for _ in $(seq 1 30); do
    curl -s --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null 2>&1 && break
    sleep 0.5
  done
  curl -s --max-time 5 "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null \
    || { echo "Chromium CDP did not come up; see /tmp/e2e-chrome.log" >&2; exit 1; }
fi

export E2E_CDP_URL="http://127.0.0.1:$CDP_PORT"
export E2E_TELEMETRY_DISABLED=1
exec npx e2e run "$@"
