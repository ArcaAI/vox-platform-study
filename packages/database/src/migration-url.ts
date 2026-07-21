/**
 * Pure resolver for Prisma Migrate's connection URL.
 *
 *   `DATABASE_URL` is the **runtime** connection string. In production it
 *   points at the PgBouncer pool (port 6432) in transaction mode.
 *   `DIRECT_URL` is the **migrations-only** connection string and points
 *   at the direct PostgreSQL endpoint (port 5432, or HAProxy R/W on 5000).
 *
 *   Prisma Migrate acquires per-session advisory locks to serialise
 *   concurrent `migrate deploy` invocations. Those locks live on the
 *   PG backend, not the client; in PgBouncer transaction mode the
 *   backend is returned to the pool between statements so the lock is
 *   effectively lost. Migrations must therefore bypass the pooler.
 *
 *   This function encapsulates that selection so it can be tested in
 *   isolation from `prisma.config.ts` (which the Prisma CLI loads in
 *   its own ts-node context).
 */

export type EnvLike = Pick<NodeJS.ProcessEnv, 'DATABASE_URL' | 'DIRECT_URL'>;

/**
 * Returns the connection URL Prisma Migrate should use.
 *
 * Precedence:
 *   1. `DIRECT_URL` (non-empty)
 *   2. `DATABASE_URL` (non-empty)
 *   3. throw — never silently produce `undefined`
 *
 * Side-effect: emits a `console.warn` when `DIRECT_URL` appears to
 * target the pooler port (6432). This is a soft warning — sometimes
 * `DIRECT_URL` is intentionally set to a session-mode pooler. The
 * warning is suppressed when `DIRECT_URL` targets the direct PG port
 * (5432) or the HAProxy R/W port (5000).
 */
export function resolveMigrationUrl(env: EnvLike): string {
  const databaseUrl = env.DATABASE_URL?.trim();
  const directUrl = env.DIRECT_URL?.trim();
  const chosen = directUrl || databaseUrl;

  if (!chosen) {
    throw new Error(
      'DATABASE_URL (or DIRECT_URL) is not set. Configure one of them ' +
        'before invoking Prisma Migrate. In production, set DIRECT_URL ' +
        'to the un-pooled PostgreSQL endpoint (e.g. port 5432 or 5000).',
    );
  }

  if (directUrl && databaseUrl && directUrl !== databaseUrl) {
    const looksDirect =
      directUrl.includes(':5432') ||
      directUrl.includes(':5000') ||
      /\?.*directConnection/i.test(directUrl);
    if (!looksDirect) {
      console.warn(
        '[prisma.config] DIRECT_URL does not look direct — ' +
          'no port 5432 / 5000 / directConnection hint detected. ' +
          'If this points at a session-mode pooler that is fine; ' +
          'otherwise set DIRECT_URL to the un-pooled PG endpoint. ' +
          'Prisma Migrate advisory locks break under transaction-mode pooling.',
      );
    }
  }

  return chosen;
}
