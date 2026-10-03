import { describe, expect, test } from "e2e";

// API-level suite: fetch + expect only, no browser. Runs in the sandbox and
// in CI against the same production URL. Everything here is read-only — no
// entries, orders, or Season 1 writes.
const BASE = process.env.E2E_BASE_URL ?? "https://pit.tannerwj.com";
const SEASON_1 = "f3a84681-cf69-4483-aa5c-f35970065c69";

describe("public site and API", { platforms: ["node"], tags: ["api"] }, () => {
  test("homepage returns 200 with the app shell", async () => {
    const res = await fetch(new URL("/?cb=e2e", BASE));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("— The Pit</title>");
  });

  test("seasons endpoint lists Season 1 with a valid status", async () => {
    const res = await fetch(new URL("/api/v1/seasons?cb=e2e", BASE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { seasons: Array<{ id: string; status: string }> };
    const s1 = body.seasons.find((s) => s.id === SEASON_1);
    expect(s1).toBeDefined();
    expect(["open", "live", "closed", "settled"]).toContain(s1?.status);
  });

  test("unauthenticated order POST is rejected with 401", async () => {
    const res = await fetch(new URL("/api/v1/orders?cb=e2e", BASE), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("llms.txt is served for agents", async () => {
    const res = await fetch(new URL("/llms.txt?cb=e2e", BASE));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
});
