// Tiny D1 helpers — thin wrappers around prepared statements.

export async function q<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all();
  return (res.results ?? []) as T[];
}

export async function q1<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  const row = await db.prepare(sql).bind(...params).first();
  return (row ?? null) as T | null;
}

export async function run(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}
