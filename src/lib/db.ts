import { Pool, type PoolClient } from "pg";

// Le pool est mis en cache sur globalThis pour survivre au hot-reload de Next.
const globalForDb = globalThis as unknown as { pool?: Pool };

export const pool =
  globalForDb.pool ??
  new Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
    max: 10,
    idleTimeoutMillis: 30_000,
  });

if (process.env.NODE_ENV !== "production") globalForDb.pool = pool;

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Exécute un bloc dans une transaction et rend le client au pool quoi qu'il
 * arrive. Utilisé partout où une mutation et son entrée de journal d'audit
 * doivent réussir ou échouer ensemble.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type { PoolClient };
