import { describe, expect, test } from "e2e";
import { api, SEASON_1_ID } from "./support/prod.js";

// Read-only: season listing against production. Season 1 is LIVE — no writes.
describe("seasons API", { platforms: ["node"], tags: ["api"] }, () => {
  test("lists Season 1 as live with all 5 pairs", async () => {
    const res = await api("/api/v1/seasons");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      seasons: Array<{
        id: string;
        name: string;
        status: string;
        market_type: string;
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
    expect(s1?.status).toBe("live");
    expect(s1?.market_type).toBe("real");
    expect(s1?.params.pairs).toEqual(["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "DOGE/USD"]);
    expect(s1?.params.starting_capital).toBe(10000);
    expect(s1?.params.max_leverage).toBe(3);
    expect(s1?.params.allow_short).toBe(true);
  });

  test("season window is a live 14-day window ending 2026-10-05", async () => {
    const res = await api("/api/v1/seasons");
    const body = (await res.json()) as {
      seasons: Array<{ id: string; starts_at: number; ends_at: number }>;
    };
    const s1 = body.seasons.find((s) => s.id === SEASON_1_ID)!;
    expect(s1.ends_at).toBeGreaterThan(Date.now());
    expect(s1.ends_at - s1.starts_at).toBe(14 * 24 * 3600 * 1000);
  });
});
