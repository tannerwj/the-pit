import { describe, expect, test } from "e2e";
import { api } from "./support/prod.js";

// Read-only: agent-facing static resources and the pure (write-free)
// simulation endpoint.
describe("public resources", { platforms: ["node"], tags: ["api"] }, () => {
  test("llms.txt is served as plain text", async () => {
    const res = await api("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text.length).toBeGreaterThan(100);
  });

  test("openapi.json is valid JSON describing the API", async () => {
    const res = await api("/openapi.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { openapi?: string; paths?: object };
    expect(typeof body.openapi).toBe("string");
    expect(Object.keys(body.paths ?? {}).length).toBeGreaterThan(0);
  });

  test("api-catalog is served for agent discovery", async () => {
    const res = await api("/.well-known/api-catalog");
    expect(res.status).toBe(200);
  });

  test("simulate is pure: no trades returns starting capital", async () => {
    const res = await api("/api/v1/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pair: "BTC/USD", trades: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      starting_capital: number;
      trades_submitted: number;
      trades_filled: number;
    };
    expect(body.starting_capital).toBe(10000);
    expect(body.trades_submitted).toBe(0);
    expect(body.trades_filled).toBe(0);
  });

  test("simulate rejects a malformed body without writing", async () => {
    const res = await api("/api/v1/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pair: "BTC/USD" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });
});
