// The Pit — per-app feedback (FEEDBACK_STANDARD.md).
// Agents file bugs/feature requests here via MCP tools feedback_submit /
// feedback_list; Constellation aggregates them via public GET /api/feedback.
// Write path is authed (agent API key); read path is public.

import type { Env } from "../lib/types";
import { requireAgent, json, err } from "../lib/auth";
import { q, q1, run } from "../lib/db";

export const FEEDBACK_TYPES = ["bug", "feature", "praise", "question"] as const;
export const FEEDBACK_STATUSES = ["new", "ack", "planned", "done", "declined"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

const TITLE_MAX = 200;
const BODY_MAX = 4000;
const REPORTER_MAX = 120;
const CONTEXT_MAX = 4000;
const SUBMIT_LIMIT_PER_HOUR = 20;
const HOUR_MS = 3_600_000;

interface FeedbackRow {
  id: number;
  type: string;
  title: string;
  body: string;
  reporter: string;
  reporter_kind: string;
  status: string;
  created_at: string;
}

/** Strip HTML tags; collapse whitespace; never returns markup. */
export function stripHtml(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isFeedbackType(v: unknown): v is FeedbackType {
  return typeof v === "string" && (FEEDBACK_TYPES as readonly string[]).includes(v);
}

function isFeedbackStatus(v: unknown): v is FeedbackStatus {
  return typeof v === "string" && (FEEDBACK_STATUSES as readonly string[]).includes(v);
}

function rowToItem(r: FeedbackRow): Record<string, unknown> {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    reporter: r.reporter,
    reporter_kind: r.reporter_kind,
    status: r.status,
    created_at: r.created_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Best-effort 20/hour per-identity submit limit. Returns an err Response or null. */
async function checkRateLimit(env: Env, identity: string): Promise<Response | null> {
  const now = Date.now();
  const row = await q1<{ window_start: number; count: number }>(
    env.DB,
    "SELECT window_start, count FROM feedback_rate WHERE identity = ?",
    identity,
  );
  if (!row || now - row.window_start >= HOUR_MS) {
    await run(
      env.DB,
      `INSERT INTO feedback_rate (identity, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT (identity) DO UPDATE SET window_start = ?, count = 1`,
      identity,
      now,
      now,
    );
    return null;
  }
  if (row.count >= SUBMIT_LIMIT_PER_HOUR) {
    return err("rate_limited", "Feedback submit limit reached (20/hour). Try again later.", 429);
  }
  await run(env.DB, "UPDATE feedback_rate SET count = count + 1 WHERE identity = ?", identity);
  return null;
}

// POST /api/v1/feedback — authed (agent API key). Body: {type, title, body?, reporter?, context?}
export async function submitFeedback(req: Request, env: Env): Promise<Response> {
  const agent = await requireAgent(req, env);
  if (agent instanceof Response) return agent;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err("bad_request", "Request body must be JSON", 400);
  }

  if (!isFeedbackType(body.type)) {
    return err("invalid_type", `"type" must be one of ${FEEDBACK_TYPES.join(", ")}`, 422);
  }
  const title = stripHtml(body.title).slice(0, TITLE_MAX);
  if (title.length === 0) {
    return err("invalid_title", '"title" is required (max 200 chars)', 422);
  }
  const text = stripHtml(body.body).slice(0, BODY_MAX);
  const reporter =
    typeof body.reporter === "string" && body.reporter.trim().length > 0
      ? stripHtml(body.reporter).slice(0, REPORTER_MAX)
      : agent.name.slice(0, REPORTER_MAX);
  let contextJson: string | null = null;
  if (body.context !== undefined && body.context !== null) {
    if (typeof body.context !== "object" || Array.isArray(body.context)) {
      return err("invalid_context", '"context" must be an object', 422);
    }
    contextJson = JSON.stringify(body.context).slice(0, CONTEXT_MAX);
  }

  const limited = await checkRateLimit(env, agent.id);
  if (limited) return limited;

  const res = await run(
    env.DB,
    `INSERT INTO app_feedback (type, title, body, reporter, reporter_kind, context_json, status, created_at)
     VALUES (?, ?, ?, ?, 'agent', ?, 'new', ?)`,
    body.type,
    title,
    text,
    reporter,
    contextJson,
    nowIso(),
  );
  const id = Number(res.meta?.last_row_id ?? 0);
  return json({ id, status: "new" }, 201);
}

// GET /api/feedback — public read. Query: status, type, limit (default 50, max 200). Newest first.
export async function listFeedback(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const statusRaw = params.get("status");
  const typeRaw = params.get("type");
  if (statusRaw !== null && !isFeedbackStatus(statusRaw)) {
    return err("invalid_status", `"status" must be one of ${FEEDBACK_STATUSES.join(", ")}`, 400);
  }
  if (typeRaw !== null && !isFeedbackType(typeRaw)) {
    return err("invalid_type", `"type" must be one of ${FEEDBACK_TYPES.join(", ")}`, 400);
  }
  let limit = 50;
  const limitRaw = params.get("limit");
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1) {
      return err("invalid_limit", '"limit" must be an integer >= 1', 400);
    }
    limit = Math.min(n, 200);
  }

  const conds: string[] = [];
  const binds: unknown[] = [];
  if (statusRaw) {
    conds.push("status = ?");
    binds.push(statusRaw);
  }
  if (typeRaw) {
    conds.push("type = ?");
    binds.push(typeRaw);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = await q<FeedbackRow>(
    env.DB,
    `SELECT id, type, title, body, reporter, reporter_kind, status, created_at
     FROM app_feedback ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...binds,
    limit,
  );
  return json({ feedback: rows.map(rowToItem) });
}
