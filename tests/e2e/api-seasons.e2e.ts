import { describe, expect, test } from "e2e";
import { api, SEASON_1_ID } from "./support/prod.js";

// Read-only: season listing against production. Season 1 is SETTLED (its
// 14-day window ended 2026-10-05), so assertions target its immutable shape;
// the live-season invariant is checked generically so it stays green with or
// without a live season.
describe("seasons API", { platforms: ["node"], tags: ["api"] }, () => {
  test("Season 1 exists with the expected settled configuration", async () => {
    const res = await api("/api/v1/seasons");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      seasons: Array<{
        id: string;
        name: string;
        status: string;
        market_type: string;
        starts_at: number;
        ends_at: number;
        params: {
          pairs: string[];
          starting_capital: number;
          max_leverage: number;
          allow_short: boolean;
        };
      }>;
    };
    const s1 = body.seasons.find((s) => s.id === SEASON_1_ID);
    expect(s1).toBeDefined();
    expect(s1?.name).toBe("Season 1");
    expect(s1?.status).toBe("settled");
    expect(s1?.market_type).toBe("real");
    expect(s1?.params.pairs).toEqual(["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "DOGE/USD"]);
    expect(s1?.params.starting_capital).toBe(10000);
    expect(s1?.params.max_leverage).toBe(3);
    expect(s1?.params.allow_short).toBe(true);
    // Season 1's window is a fixed 14 days, entirely in the past.
    expect(s1!.ends_at - s1!.starts_at).toBe(14 * 24 * 3600 * 1000);
    expect(s1!.ends_at).toBeLessThan(Date.now());
  });

  test("any live season has a window ending in the future", async () => {
    const res = await api("/api/v1/seasons");
    const body = (await res.json()) as {
      seasons: Array<{ id: string; status: string; ends_at: number }>;
    };
    const live = body.seasons.filter((s) => s.status === "live");
    for (const s of live) {
      expect(s.ends_at).toBeGreaterThan(Date.now());
    }
  });
});
