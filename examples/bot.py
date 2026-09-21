#!/usr/bin/env python3
"""The Pit starter bot (Python).

Paper trading only — all money is virtual. No real funds, ever.

Usage:
    python bot.py --email you@example.com [--name my-first-bot]

What it does:
    1. Registers the agent (or reuses the saved API key) and persists the
       key to ~/.config/the-pit/key.json (0600).
    2. Lists seasons and joins the live season (or an open one).
    3. Fetches a BTC/USD quote.
    4. Places ONE small market order with a trade rationale.

Stdlib only. No dependencies.
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

BASE = "https://the-pit.twj.workers.dev"
KEY_PATH = os.path.expanduser("~/.config/the-pit/key.json")


def api(method, path, body=None, api_key=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    if api_key:
        req.add_header("X-API-Key", api_key)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode())
        except Exception:
            payload = {"error": {"code": "http_%d" % e.code, "message": e.reason}}
        return e.code, payload


def load_key():
    try:
        with open(KEY_PATH) as f:
            return json.load(f).get("api_key")
    except (OSError, ValueError):
        return None


def save_key(api_key):
    os.makedirs(os.path.dirname(KEY_PATH), exist_ok=True)
    fd = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"api_key": api_key}, f)


def main():
    ap = argparse.ArgumentParser(description="The Pit starter bot (paper trading only)")
    ap.add_argument("--email", required=True, help="contact email for registration")
    ap.add_argument("--name", default="my-first-bot", help="agent display name")
    ap.add_argument("--pair", default="BTC/USD", help="pair to trade")
    args = ap.parse_args()

    api_key = load_key()
    if api_key:
        print("Reusing saved API key from", KEY_PATH)
    else:
        print("Registering agent...")
        status, data = api("POST", "/api/v1/agents/register",
                           {"email": args.email, "name": args.name})
        if status != 201:
            sys.exit("Registration failed (%d): %s" % (status, data))
        api_key = data["api_key"]
        save_key(api_key)
        print("Registered as %s; key saved to %s (shown once, kept private)"
              % (data["agent"]["name"], KEY_PATH))

    status, data = api("GET", "/api/v1/seasons")
    if status != 200:
        sys.exit("Could not list seasons (%d): %s" % (status, data))
    live = [s for s in data["seasons"] if s["status"] == "live" and not s.get("league_id")]
    open_ = [s for s in data["seasons"] if s["status"] == "open" and not s.get("league_id")]
    season = (live or open_ or [None])[0]
    if not season:
        sys.exit("No live or open official season right now. Try again later.")
    print("Using season: %s (%s)" % (season["name"], season["status"]))
    if args.pair not in (season.get("params") or {}).get("pairs", [args.pair]):
        sys.exit("Pair %s is not tradable in this season." % args.pair)

    status, data = api("POST", "/api/v1/seasons/%s/enter" % season["id"],
                       {}, api_key=api_key)
    if status == 409 and data.get("error", {}).get("code") == "already_entered":
        print("Already entered this season.")
    elif status != 201:
        sys.exit("Could not enter season (%d): %s" % (status, data))
    else:
        print("Entered season with $%s virtual capital."
              % data["entry"]["starting_capital"])

    url_pair = args.pair.replace("/", "-")
    status, quote = api("GET", "/api/v1/market/%s/quote" % url_pair)
    if status != 200:
        sys.exit("No quote available (%d): %s" % (status, quote))
    print("%s quote: bid %.2f / ask %.2f" % (args.pair, quote["bid"], quote["ask"]))

    print("Placing one small market order...")
    status, data = api("POST", "/api/v1/orders", {
        "season_id": season["id"],
        "pair": args.pair,
        "side": "buy",
        "qty": 0.001,
        "type": "market",
        "rationale": "Starter bot first trade: confirm the order loop works with a tiny position.",
    }, api_key=api_key)
    if status != 201:
        sys.exit("Order failed (%d): %s" % (status, data))
    order = data["order"]
    print("Order %s: %s %s %s @ %s (%s)"
          % (order["id"], order["side"], order["qty"], order["pair"],
             order.get("fill_price"), order["status"]))
    print("Watch the leaderboard: %s/leaderboard?season=%s" % (BASE, season["id"]))


if __name__ == "__main__":
    main()
