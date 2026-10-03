#!/usr/bin/env bash
# scripts/e2e-sandbox.sh — run the e2e suite inside this sandbox.
#
# The sandbox blocks Chromium's direct egress and localhost, and Playwright
# browser downloads stall, so this wrapper:
#   1. starts the CONNECT forwarder (Chromium -> authenticated egress proxy)
#   2. launches /opt/meta-chromium/chrome headless with CDP + the forwarder
#   3. runs `e2e run` with E2E_CDP_URL pointed at it
#   4. tears down what it started.
#
# Usage: ./scripts/e2e-sandbox.sh [--target prod-ui] [e2e run args...]
# Env:   E2E_PROD_URL (default https://the-pit.twj.workers.dev)
#        E2E_LOCAL_URL (for --target local-api; start wrangler dev separately)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

PROXY_PORT=18080
CDP_PORT=9222
CHROME_BIN="${CHROME_BIN:-/opt/meta-chromium/chrome}"
CHROME_PROFILE="$(mktemp -d /tmp/e2e-chrome.XXXXXX)"

cleanup() {
  [[ -n "${CHROME_PID:-}" ]] && kill "$CHROME_PID" 2>/dev/null || true
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true
  rm -rf "$CHROME_PROFILE"
}
trap cleanup EXIT

# 1. CONNECT forwarder for Chromium's egress.
if ! python3 -c "import socket; socket.create_connection(('127.0.0.1', $PROXY_PORT), timeout=3).close()"; then
  python3 "$SCRIPT_DIR/proxy_fwd.py" > /tmp/e2e-proxy.log 2>&1 &
  PROXY_PID=$!
  for _ in $(seq 1 20); do
    python3 -c "import socket; socket.create_connection(('127.0.0.1', $PROXY_PORT), timeout=2).close()" 2>/dev/null && break
    sleep 0.5
  done
fi

# 2. Chromium with remote debugging + proxy.
if ! curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$CDP_PORT/json/version"; then
  "$CHROME_BIN" \
    --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --remote-debugging-port="$CDP_PORT" \
    --proxy-server="http://127.0.0.1:$PROXY_PORT" \
    --user-data-dir="$CHROME_PROFILE" \
    about:blank > /tmp/e2e-chrome.log 2>&1 &
  CHROME_PID=$!
  for _ in $(seq 1 30); do
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" && break
    sleep 0.5
  done
  curl -s --max-time 5 "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null \
    || { echo "Chromium CDP did not come up; see /tmp/e2e-chrome.log"; exit 1; }
fi

# 3. Run the suite.
export E2E_CDP_URL="http://127.0.0.1:$CDP_PORT"
export E2E_TELEMETRY_DISABLED=1
exec npx e2e run "$@"
