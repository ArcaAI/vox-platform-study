// packages/database/tests/pgbouncer-validation/_helpers/clients.ts
//
// Small client factory for the PgBouncer validation rig.
//
// * `createPooledPrisma()`         — Prisma 7 client through PgBouncer (port 6532)
// * `createExtendedPooledPrisma()` — same as above, with soft-delete extension applied
// * `createDirectPg()`             — raw `pg.Pool` against direct PG  (port 5532)
// * `createPoolerAdminPg()`        — raw `pg.Pool` against PgBouncer's
//                                    virtual `pgbouncer` admin database
//                                    (for SHOW POOLS / SHOW STATS / SHOW CONFIG)

import {
  createNewExtendedPrismaClient,
  createNewPrismaClient,
  type CorePrismaClient,
  type ExtendedCorePrismaClient,
} from '@arcaai/database';
import { Pool, type PoolConfig } from 'pg';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[pgbouncer-validation] ${name} is not set. ` +
        `Run rig tests via \`pnpm pgbv:test\` so dotenv-cli loads ` +
        `packages/database/tests/pgbouncer-validation/.env`,
    );
  }
  return value;
}

export function createPooledPrisma(): CorePrismaClient {
  // Sanity: ensure DATABASE_URL points at the pooler port.
  const url = requireEnv('DATABASE_URL');
  if (!url.includes(':6532')) {
    throw new Error(
      `[pgbouncer-validation] DATABASE_URL must point at port 6532 (pooler); got ${url}`,
    );
  }
  return createNewPrismaClient();
}

export function createExtendedPooledPrisma(): ExtendedCorePrismaClient {
  const url = requireEnv('DATABASE_URL');
  if (!url.includes(':6532')) {
    throw new Error(
      `[pgbouncer-validation] DATABASE_URL must point at port 6532 (pooler); got ${url}`,
    );
  }
  return createNewExtendedPrismaClient();
}

export function createDirectPg(overrides: Partial<PoolConfig> = {}): Pool {
  const direct = requireEnv('DIRECT_URL');
  return new Pool({
    connectionString: direct,
    max: 5,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
    ...overrides,
  });
}

/**
 * Returns a raw pg.Pool that talks to PgBouncer's internal admin database
 * (`SHOW POOLS`, `SHOW STATS`, `SHOW CONFIG`, …). The admin DB only accepts
 * the simple protocol, so callers must use single-statement queries.
 */
export function createPoolerAdminPg(): Pool {
  const url = new URL(requireEnv('DATABASE_URL'));
  url.pathname = '/pgbouncer';
  return new Pool({
    connectionString: url.toString(),
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
}
