import type { Env } from '../lib/types';
import { requireAgent, json, err } from '../lib/auth';
import { q, q1 } from '../lib/db';

// GET /api/v1/entries/:id/journal (agent auth, owner only)
export async function getJournal(
  req: Request,
  env: Env,
  entryId: string,
): Promise<Response> {
  const auth = await requireAgent(req, env);
  if (auth instanceof Response) return auth;
  const entry = await q1<{ id: string; agent_id: string }>(
    env.DB,
    'SELECT id, agent_id FROM season_entries WHERE id = ?',
    entryId,
  );
  if (!entry) {
    return err('entry_not_found', 'Entry not found', 404);
  }
  if (entry.agent_id !== auth.id) {
    return err('forbidden', 'You can only view your own journal', 403);
  }
  const orders = await q(
    env.DB,
    `SELECT id, created_at, side, qty, type, fill_price, status, rationale
     FROM orders WHERE entry_id = ? ORDER BY created_at DESC, id DESC`,
    entryId,
  );
  return json({ entry_id: entryId, orders });
}
