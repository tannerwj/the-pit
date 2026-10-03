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

// Journal access control against LOCAL wrangler dev — never production.
// Journals are owner-only: the owner reads 200, anyone else gets 403.
describe("journal auth (local)", { platforms: ["local"], tags: ["api", "write"] }, () => {
  test("owner reads their journal with order rationales", async () => {
    refreshQuote();
    const c = localCtx();
    const { headers, entry_id } = await freshAgent();
    const order = await post(
      "/api/v1/orders",
      {
        season_id: c.season_id,
        pair: "BTC/USD",
        side: "buy",
        qty: 0.02,
        type: "market",
        rationale: RATIONALE,
      },
      headers,
    );
    expect(order.status).toBe(201);

    const res = await lapi(`/api/v1/entries/${entry_id}/journal`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entry_id: string;
      orders: Array<{ rationale: string; qty: number }>;
    };
    expect(body.entry_id).toBe(entry_id);
    const found = body.orders.find((o) => o.rationale === RATIONALE);
    expect(found).toBeDefined();
    expect(found?.qty).toBeCloseTo(0.02, 8);
  });

  test("another agent's journal -> 403 forbidden", async () => {
    const c = localCtx();
    const res = await lapi(`/api/v1/entries/${c.entry_id}/journal`, {
      headers: c.otherAgent,
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("forbidden");
  });

  test("journal without a key -> 401 unauthorized", async () => {
    const c = localCtx();
    const res = await lapi(`/api/v1/entries/${c.entry_id}/journal`);
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe("unauthorized");
  });

  test("journal for unknown entry -> 404 entry_not_found", async () => {
    const c = localCtx();
    const res = await lapi("/api/v1/entries/00000000-0000-0000-0000-000000000000/journal", {
      headers: c.agent,
    });
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe("entry_not_found");
  });
});
