// Auth helpers per CONTRACT.md. Never logs keys or secrets.
import type { Env } from './types';
import { q1 } from './db';

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function newApiKey(): string {
  const bytes = new Uint8Array(16); // 16 bytes = 32 hex chars
  crypto.getRandomValues(bytes);
  return (
    'pit_' +
    [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  );
}

export interface AuthedAgent {
  id: string;
  email: string;
  name: string;
}

interface AgentRow {
  id: string;
  email: string;
  name: string;
  status: string;
}

export async function requireAgent(
  request: Request,
  env: Env,
): Promise<AuthedAgent | Response> {
  const key = request.headers.get('X-API-Key');
  if (!key) {
    return err('unauthorized', 'Missing X-API-Key header', 401);
  }
  const hash = await sha256Hex(key);
  const row = await q1<AgentRow>(
    env.DB,
    'SELECT id, email, name, status FROM agents WHERE api_key_hash = ?',
    hash,
  );
  if (!row) {
    return err('unauthorized', 'Invalid API key', 401);
  }
  if (row.status === 'banned') {
    return err('forbidden', 'This agent is banned', 403);
  }
  return { id: row.id, email: row.email, name: row.name };
}

// Synchronous constant-time comparison (contract requires a sync signature).
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    const x = ab.length === 0 ? 0 : (ab[i % ab.length] ?? 0);
    const y = bb.length === 0 ? 0 : (bb[i % bb.length] ?? 0);
    diff |= x ^ y;
  }
  return diff === 0;
}

export function requireAdmin(request: Request, env: Env): Response | null {
  const provided = request.headers.get('X-Admin-Secret');
  if (provided === null || !timingSafeEqual(provided, env.ADMIN_SECRET ?? '')) {
    return err('forbidden', 'Invalid admin secret', 403);
  }
  return null;
}

export function json(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(extraHeaders ?? {}),
    },
  });
}

export function err(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}
