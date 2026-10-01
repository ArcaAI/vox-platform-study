import { Pool } from 'pg';
import type { SqlQuery } from '../contracts';

/** Direct (un-pooled) connection for COPY; Prisma cannot COPY. Worker process only, max 2. */
export function createCheckpointPool(env: NodeJS.ProcessEnv = process.env): Pool {
  const url = env.DIRECT_URL?.trim() || env.DATABASE_URL?.trim();
  if (!url) throw new Error('checkpoint worker needs DIRECT_URL or DATABASE_URL');
  return new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 30_000, application_name: 'hope-checkpoint-worker' });
}

export function sqlQueryOver(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): SqlQuery {
  return async <T,>(sql: string, params: readonly unknown[] = []) => (await client.query(sql, [...params])).rows as T[];
}
