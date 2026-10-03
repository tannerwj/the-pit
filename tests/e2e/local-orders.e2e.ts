import { describe, expect, test } from "e2e";
import {
  localCtx,
  post,
  lapi,
  errCode,
  refreshQuote,
  freshAgent,
  RATIONALE,
} from "./support/local.js";

// Write-flow tests against LOCAL wrangler dev + scratch D1 — never production.
// Covers the full order-validation chain (first failure wins) plus the
// market-fill and cancel lifecycle.
describe("order validation (local)", { platforms: ["local"], tags: ["api", "write"] }, () => {
  const base = (over: Record<string, unknown> = {}) => ({
    season_id: localCtx().season_id,
    pair: "BTC/USD",
    side: "buy",
    qty: 0.01,
    type: "market",
    rationale: RATIONALE,
    ...over,
  });

  test("rationale is validated first: missing/blank/short -> 422 rationale_required", async () => {
    const c = localCtx();
    for (const rationale of [undefined, "", "  ", "ab"]) {
      const body = base() as Record<string, unknown>;
      if (rationale === undefined) delete body.rationale;
      else body.rationale = rationale;
      const res = await post("/api/v1/orders", body, c.agent);
      expect(res.status).toBe(422);
      expect(await errCode(res)).toBe("rationale_required");
    }
  });

  test("rationale wins over a bad pair (validation order)", async () => {
    const c = localCtx();
    const res = await post("/api/v1/orders", base({ rationale: "x", pair: "FAKE/USD" }), c.agent);
    expect(res.status).toBe(422);
    expect(await errCode(res)).toBe("rationale_required");
  });

  test("unknown season -> 404 season_not_found", async () => {
    const c = localCtx();
    const res = await post(
      "/api/v1/orders",
      base({ season_id: "00000000-0000-0000-0000-000000000000" }),
      c.agent,
    );
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe("season_not_found");
  });

  test("pair outside the season -> 422 bad_pair", async () => {
    const c = localCtx();
    const res = await post("/api/v1/orders", base({ pair: "ETH/USD" }), c.agent);
    expect(res.status).toBe(422);
    expect(await errCode(res)).toBe("bad_pair");
  });

  test("bad order shapes -> 422 bad_order", async () => {
    const c = localCtx();
    const cases: Array<Record<string, unknown>> = [
      { side: "hold" },
      { qty: 0 },
      { qty: -1 },
      { qty: 101 },
      { type: "stop" },
      { type: "limit" }, // missing limit_price
      { type: "limit", limit_price: -5 },
    ];
    for (const over of cases) {
      const res = await post("/api/v1/orders", base(over), c.agent);
      expect(res.status).toBe(422);
      expect(await errCode(res)).toBe("bad_order");
    }
  });

  test("agent with no entry -> 409 entry_closed", async () => {
    const reg = await post("/api/v1/agents/register", {
      email: `noentry-${Date.now()}@local.test`,
      name: "noentry",
    });
    const { api_key } = (await reg.json()) as { api_key: string };
    const res = await post("/api/v1/orders", base(), { "X-API-Key": api_key });
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe("entry_closed");
  });

  test("leverage beyond 3x -> 422 leverage_exceeded", async () => {
    const { headers } = await freshAgent();
    // 100 BTC @ $67k ≈ $6.7M notional on $10k capital — far past 3x.
    const res = await post(
      "/api/v1/orders",
      base({ qty: 100, type: "limit", limit_price: 67000 }),
      headers,
    );
    expect(res.status).toBe(422);
    expect(await errCode(res)).toBe("leverage_exceeded");
  });

  test("valid market order fills immediately and shows in the portfolio", async () => {
    refreshQuote();
    const { headers } = await freshAgent();
    const c = localCtx();
    const res = await post("/api/v1/orders", base(), headers);
    expect(res.status).toBe(201);
    const { order } = (await res.json()) as {
      order: { id: string; status: string; fill_price: number; pair: string };
    };
    expect(order.status).toBe("filled");
    expect(order.fill_price).toBeGreaterThan(0);
    expect(order.pair).toBe("BTC/USD");

    const pf = await lapi(`/api/v1/portfolio?season_id=${c.season_id}`, { headers });
    expect(pf.status).toBe(200);
    const body = (await pf.json()) as {
      positions: Array<{ pair: string; qty: number }>;
      equity: number;
    };
    const pos = body.positions.find((p) => p.pair === "BTC/USD");
    expect(pos?.qty).toBeCloseTo(0.01, 8);
    expect(body.equity).toBeGreaterThan(0);
  });

  test("limit order rests open, cancels, and cannot be cancelled twice", async () => {
    const { headers } = await freshAgent();
    // Far below market: rests open.
    const res = await post("/api/v1/orders", base({ type: "limit", limit_price: 1000 }), headers);
    expect(res.status).toBe(201);
    const { order } = (await res.json()) as { order: { id: string; status: string } };
    expect(order.status).toBe("open");

    const cancel = await lapi(`/api/v1/orders/${order.id}`, {
      method: "DELETE",
      headers,
    });
    expect(cancel.status).toBe(200);
    const cancelled = (await cancel.json()) as { order: { status: string } };
    expect(cancelled.order.status).toBe("cancelled");

    const again = await lapi(`/api/v1/orders/${order.id}`, {
      method: "DELETE",
      headers,
    });
    expect(again.status).toBe(409);
    expect(await errCode(again)).toBe("already_filled");
  });
});
