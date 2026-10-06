// The Pit — feedback tests (mock + in-memory D1, no network).
// Covers: submit validation/parity with REST, HTML stripping, length caps,
// rate limit (20/hour), list filters/limits/ordering, public GET /api/feedback,
// MCP tools/list + tools/call dispatch, and a full submit -> list -> GET smoke.
import { describe, it, expect, beforeEach } from "vitest";
import { submitFeedback, listFeedback, stripHtml } from "../src/routes/feedback";
import { handleMcp, MCP_TOOL_NAMES } from "../src/routes/mcp";
import type { Env } from "../src/lib/types";
import { sha256Hex } from "../src/lib/auth";

// --- minimal in-memory D1 ---------------------------------------------------

type Row = Record<string, unknown>;

class FakeD1 {
  feedback: Row[] = [];
  rate: Row[] = [];
  agents: Row[] = [{ id: "agent-1", email: "a@x.com", name: "TestAgent", status: "active" }];
  agentKeyHash = "";
  private seq = 0;

  prepare(sql: string) {
    const self = this;
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind(...p: unknown[]) {
        return {
          async all() {
            return { results: self.all(norm, p) };
          },
          async first() {
            return self.first(norm, p);
          },
          async run() {
            return self.run(norm, p);
          },
        };
      },
      batch: async () => [] as unknown[],
      all() {
        return this.bind().all();
      },
      first() {
        return this.bind().first();
      },
      run() {
        return this.bind().run();
      },
    };
  }

  private all(sql: string, p: unknown[]): Row[] {
    if (
      sql.startsWith(
        "SELECT id, type, title, body, reporter, reporter_kind, status, created_at FROM app_feedback",
      )
    ) {
      let rows = [...this.feedback];
      let i = 0;
      if (sql.includes("status = ?")) {
        const s = p[i++];
        rows = rows.filter((r) => r.status === s);
      }
      if (sql.includes("type = ?")) {
        const t = p[i++];
        rows = rows.filter((r) => r.type === t);
      }
      rows.sort(
        (a, b) =>
          (b.created_at as string).localeCompare(a.created_at as string) ||
          (b.id as number) - (a.id as number),
      );
      const limit = p[i++] as number;
      return rows.slice(0, limit);
    }
    return [];
  }

  private first(sql: string, p: unknown[]): Row | null {
    if (sql.startsWith("SELECT id, email, name, status FROM agents")) {
      const row = this.agents.find((a) => (a as Row & { key?: string }).key === p[0]);
      return row ? { id: row.id, email: row.email, name: row.name, status: row.status } : null;
    }
    if (sql.startsWith("SELECT window_start, count FROM feedback_rate")) {
      return this.rate.find((r) => r.identity === p[0]) ?? null;
    }
    return null;
  }

  private run(sql: string, p: unknown[]): { success: boolean; meta: { last_row_id: number } } {
    if (sql.startsWith("INSERT INTO app_feedback")) {
      this.seq += 1;
      this.feedback.push({
        id: this.seq,
        type: p[0],
        title: p[1],
        body: p[2],
        reporter: p[3],
        reporter_kind: "agent",
        context_json: p[4],
        status: "new",
        created_at: p[5],
      });
      return { success: true, meta: { last_row_id: this.seq } };
    }
    if (sql.startsWith("INSERT INTO feedback_rate")) {
      this.rate = this.rate.filter((r) => r.identity !== p[0]);
      this.rate.push({ identity: p[0], window_start: p[1], count: 1 });
      return { success: true, meta: { last_row_id: 0 } };
    }
    if (sql.startsWith("UPDATE feedback_rate SET count")) {
      const row = this.rate.find((r) => r.identity === p[0]);
      if (row) row.count = (row.count as number) + 1;
      return { success: true, meta: { last_row_id: 0 } };
    }
    return { success: true, meta: { last_row_id: 0 } };
  }

  async setAgentKey(key: string) {
    this.agentKeyHash = await sha256Hex(key);
    (this.agents[0] as Row & { key: string }).key = this.agentKeyHash;
  }
}

const API_KEY = "pit_test_key_123";
let db: FakeD1;
let env: Env;

beforeEach(async () => {
  db = new FakeD1();
  await db.setAgentKey(API_KEY);
  env = { DB: db, ADMIN_SECRET: "x" } as unknown as Env;
});

function post(body: unknown, key: string = API_KEY): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["X-API-Key"] = key;
  return new Request("https://the-pit.twj.workers.dev/api/v1/feedback", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request(`https://the-pit.twj.workers.dev${path}`, { method: "GET" });
}

function rpcCall(name: string, args: Record<string, unknown>): Request {
  return new Request("https://the-pit.twj.workers.dev/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

async function toolText(res: Response): Promise<unknown> {
  const j = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { parsed: JSON.parse(j.result.content[0].text), isError: j.result.isError === true };
}

// --- unit: stripHtml ---

describe("stripHtml", () => {
  it("removes tags and collapses whitespace", () => {
    expect(stripHtml("<b>hi</b> <script>alert(1)</script>")).toBe("hi alert(1)");
    expect(stripHtml(123)).toBe("");
  });
});

// --- REST submit ---

describe("submitFeedback", () => {
  it("accepts a valid submission and returns {id, status}", async () => {
    const res = await submitFeedback(
      post({ type: "feature", title: "Dark mode", body: "Please add dark mode" }),
      env,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 1, status: "new" });
  });

  it("defaults reporter to the agent name and strips HTML", async () => {
    const res = await submitFeedback(
      post({ type: "bug", title: "<img src=x>Crash", body: "<p>it <em>broke</em></p>" }),
      env,
    );
    expect(res.status).toBe(201);
    const row = db.feedback[0];
    expect(row.title).toBe("Crash");
    expect(row.body).toBe("it broke");
    expect(row.reporter).toBe("TestAgent");
    expect(row.reporter_kind).toBe("agent");
    expect(row.status).toBe("new");
  });

  it("enforces title/body length caps", async () => {
    const res = await submitFeedback(
      post({ type: "question", title: "t".repeat(500), body: "b".repeat(9000) }),
      env,
    );
    expect(res.status).toBe(201);
    expect((db.feedback[0].title as string).length).toBe(200);
    expect((db.feedback[0].body as string).length).toBe(4000);
  });

  it("stores context as JSON", async () => {
    await submitFeedback(
      post({ type: "feature", title: "X", context: { tool: "place_order", pair: "BTC-USD" } }),
      env,
    );
    expect(JSON.parse(db.feedback[0].context_json as string)).toEqual({
      tool: "place_order",
      pair: "BTC-USD",
    });
  });

  it("rejects bad type / missing title / bad context", async () => {
    expect((await submitFeedback(post({ type: "nope", title: "x" }), env)).status).toBe(422);
    expect((await submitFeedback(post({ type: "bug", title: "   " }), env)).status).toBe(422);
    expect(
      (await submitFeedback(post({ type: "bug", title: "x", context: [1] }), env)).status,
    ).toBe(422);
  });

  it("requires a valid API key", async () => {
    expect((await submitFeedback(post({ type: "bug", title: "x" }, "wrong"), env)).status).toBe(
      401,
    );
    const noKey = new Request("https://the-pit.twj.workers.dev/api/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "bug", title: "x" }),
    });
    expect((await submitFeedback(noKey, env)).status).toBe(401);
  });

  it("rate-limits at 20/hour per agent", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await submitFeedback(post({ type: "bug", title: `t${i}` }), env);
      expect(res.status).toBe(201);
    }
    const res = await submitFeedback(post({ type: "bug", title: "one more" }), env);
    expect(res.status).toBe(429);
  });
});

// --- REST list ---

describe("listFeedback", () => {
  it("returns newest first with the standard shape", async () => {
    await submitFeedback(post({ type: "feature", title: "First" }), env);
    await submitFeedback(post({ type: "bug", title: "Second" }), env);
    const res = await listFeedback(get("/api/feedback"), env);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { feedback: { id: number; title: string }[] };
    expect(j.feedback.map((f) => f.title)).toEqual(["Second", "First"]);
    const f = j.feedback[0] as Record<string, unknown>;
    expect(Object.keys(f).sort()).toEqual(
      ["body", "created_at", "id", "reporter", "reporter_kind", "status", "title", "type"].sort(),
    );
    expect(f.reporter_kind).toBe("agent");
  });

  it("filters by status/type and clamps limit", async () => {
    await submitFeedback(post({ type: "feature", title: "F1" }), env);
    await submitFeedback(post({ type: "bug", title: "B1" }), env);
    const byType = (await (await listFeedback(get("/api/feedback?type=bug"), env)).json()) as {
      feedback: unknown[];
    };
    expect(byType.feedback).toHaveLength(1);
    const bad = await listFeedback(get("/api/feedback?type=nope"), env);
    expect(bad.status).toBe(400);
    const badLimit = await listFeedback(get("/api/feedback?limit=0"), env);
    expect(badLimit.status).toBe(400);
  });

  it("is public (no auth needed)", async () => {
    const res = await listFeedback(get("/api/feedback"), env);
    expect(res.status).toBe(200);
  });
});

// --- MCP tools ---

describe("feedback MCP tools", () => {
  it("tools/list includes feedback_submit and feedback_list", async () => {
    expect(MCP_TOOL_NAMES).toContain("feedback_submit");
    expect(MCP_TOOL_NAMES).toContain("feedback_list");
    const res = await handleMcp(
      new Request("https://the-pit.twj.workers.dev/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      env,
    );
    const j = (await res.json()) as { result: { tools: { name: string; inputSchema: unknown }[] } };
    const names = j.result.tools.map((t) => t.name);
    expect(names).toContain("feedback_submit");
    expect(names).toContain("feedback_list");
  });

  it("feedback_submit requires api_key and validates type", async () => {
    const missing = await handleMcp(rpcCall("feedback_submit", { type: "bug", title: "x" }), env);
    const j = (await missing.json()) as { error: { code: number } };
    expect(j.error.code).toBe(-32602); // missing api_key
    const badType = await handleMcp(
      rpcCall("feedback_submit", { api_key: API_KEY, type: "nope", title: "x" }),
      env,
    );
    const j2 = (await badType.json()) as { error: { code: number } };
    expect(j2.error.code).toBe(-32602);
  });

  it("feedback_submit -> feedback_list smoke (REST parity)", async () => {
    const sub = (await toolText(
      await handleMcp(
        rpcCall("feedback_submit", {
          api_key: API_KEY,
          type: "feature",
          title: "MCP smoke",
          body: "via tool",
        }),
        env,
      ),
    )) as { parsed: { id: number; status: string }; isError: boolean };
    expect(sub.isError).toBe(false);
    expect(sub.parsed).toEqual({ id: 1, status: "new" });

    const listed = (await toolText(
      await handleMcp(rpcCall("feedback_list", { type: "feature" }), env),
    )) as { parsed: { feedback: { title: string }[] }; isError: boolean };
    expect(listed.isError).toBe(false);
    expect(listed.parsed.feedback.map((f) => f.title)).toEqual(["MCP smoke"]);

    // and the public HTTP GET sees it too
    const http = (await (await listFeedback(get("/api/feedback"), env)).json()) as {
      feedback: { title: string }[];
    };
    expect(http.feedback.map((f) => f.title)).toEqual(["MCP smoke"]);
  });
});
