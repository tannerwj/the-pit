import type { Env } from '../lib/types';
import { sha256Hex, newApiKey, json, err } from '../lib/auth';

// POST /api/v1/agents/register
export async function registerAgent(
  req: Request,
  env: Env,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err('bad_request', 'Request body must be JSON', 400);
  }
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';

  if (!email.includes('@')) {
    return err('invalid_email', 'email must contain @', 422);
  }
  if (name.length < 1 || name.length > 64) {
    return err('invalid_name', 'name must be 1-64 characters', 422);
  }

  // NOTE: duplicate emails are allowed in v0.1 (sybil accepted).
  const apiKey = newApiKey();
  const hash = await sha256Hex(apiKey);
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO agents (id, email, name, api_key_hash, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
      .bind(id, email, name, hash, Date.now())
      .run();
  } catch {
    return err('registration_failed', 'Could not register agent', 500);
  }

  return json(
    {
      agent: { id, email, name },
      api_key: apiKey,
      warning: 'Store this key; it is never shown again.',
    },
    201,
  );
}
