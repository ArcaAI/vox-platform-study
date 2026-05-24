// packages/database/tests/pgbouncer-validation/__tests__/06-prisma-migrate.test.ts
//
// Task 1.12 — `prisma migrate deploy` MUST succeed when its connection
// string is the un-pooled DIRECT_URL (Phase 0 mandate: advisory locks
// don't survive PgBouncer transaction-mode swaps; Prisma Migrate uses
// `pg_advisory_lock` on `_prisma_migrations` to serialise concurrent
// migrators).
//
// Strategy: spin up a brand-new database alongside the rig's `hope` DB
// (`hope_mig_t1`), point Prisma at it via DIRECT_URL, run `prisma
// migrate deploy`, and assert all 4 migration files landed. CREATE
// DATABASE is allowed (not a destructive op); the database stays around
// until the next `pgbv:down -v` wipes the volume.
//
// Phase 1 rubric (per plan §1.18):
//   * R-MIG-1 — `prisma migrate deploy` via DIRECT_URL applies all 4
//               migration directories, _prisma_migrations has 4 rows

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

const directHost = '127.0.0.1';
const directPort = 5532;
const adminDb = 'postgres';
const testDb = `hope_mig_t1`;
const migrationDir = path.resolve(
  __dirname,
  '../../../src/prisma/db_main/migrations',
);
const monorepoRoot = path.resolve(__dirname, '../../../../..');

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: directHost,
    port: directPort,
    user: 'hope_app',
    password: 'hope_app_local',
    database: adminDb,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureFreshTestDatabase(): Promise<void> {
  // We deliberately do NOT drop the test DB on cleanup (user-rule:
  // DROP DATABASE requires approval). If it exists from a prior run we
  // skip creation; if not we create it. The test verifies a brand-new
  // schema is created within the migrations test below.
  await withAdmin(async (client) => {
    const exists = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname = $1`,
      [testDb],
    );
    if (exists.rows.length === 0) {
      // identifier is a literal hard-coded above; safe to inline.
      await client.query(`CREATE DATABASE "${testDb}"`);
    }
  });
}

beforeAll(async () => {
  await ensureFreshTestDatabase();
});

afterAll(async () => {
  // Leave hope_mig_t1 in place. `pnpm pgbv:down` -v removes the volume
  // (and thus this DB) when the rig is torn down.
});

describe('PgBouncer txn-mode — Prisma Migrate via DIRECT_URL (Task 1.12)', () => {
  it('R-MIG-1: prisma migrate deploy via DIRECT_URL applies all 4 migrations', async () => {
    const targetUrl = `postgresql://hope_app:hope_app_local@${directHost}:${directPort}/${testDb}?schema=public`;

    // `prisma migrate deploy` is non-interactive and intended for prod-style
    // deployment. We invoke it via pnpm so the workspace resolution works.
    const out = execFileSync(
      'pnpm',
      ['--filter', '@arcaai/database', 'exec', 'prisma', 'migrate', 'deploy'],
      {
        cwd: monorepoRoot,
        env: {
          ...process.env,
          // Override DATABASE_URL for the migrate process so prisma.config.ts
          // uses our isolated `hope_mig_t1` DB through the direct port.
          DATABASE_URL: targetUrl,
          // prisma.config.ts also accepts DIRECT_URL (Phase 0 mandate); set
          // both to be explicit.
          DIRECT_URL: targetUrl,
          NODE_ENV: 'test',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      },
    );

    expect(out).toMatch(/migrations have been successfully applied|No pending migrations to apply/);

    // Independent verification: query _prisma_migrations on the test DB.
    const verify = new Client({
      host: directHost,
      port: directPort,
      user: 'hope_app',
      password: 'hope_app_local',
      database: testDb,
    });
    await verify.connect();
    try {
      const { rows } = await verify.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
      );
      expect(Number(rows[0]!.count)).toBe(4);

      // Sanity: at least some of the migrated core tables exist.
      const tableCheck = await verify.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = 'core' AND tablename IN ('Consultation', 'GlobalSetting', 'AuditLog')
         ORDER BY tablename`,
      );
      expect(tableCheck.rows.map((r) => r.tablename)).toEqual([
        'AuditLog',
        'Consultation',
        'GlobalSetting',
      ]);
    } finally {
      await verify.end();
    }
  }, 90_000);
});
