/**
 * HarnessAuditEvent WORM enforcement — live-Postgres regression guard.
 *
 * The migration `…_task_330_add_clinical_harness_eval_and_worm_audit` runs
 *   REVOKE UPDATE, DELETE ON core."HarnessAuditEvent" FROM <app role>
 * so the hash-chained audit trail is append-only at the DATABASE-PRIVILEGE
 * layer, not only in application code. This test proves those semantics
 * deterministically:
 *
 *   1. Provision a dedicated NON-superuser role.
 *   2. GRANT it the full table DML the bootstrap's ALTER DEFAULT PRIVILEGES
 *      would grant a real app role (SELECT/INSERT/UPDATE/DELETE).
 *   3. Apply the SAME revoke the migration applies (REVOKE UPDATE, DELETE).
 *   4. Act AS that role (`SET LOCAL ROLE`) and assert UPDATE + DELETE on a real
 *      row are rejected with permission-denied (SQLSTATE 42501), while SELECT
 *      and INSERT still succeed.
 *
 * Why a dedicated role rather than the real hope_app / hope_app_template: the
 * dev/test DATABASE_URL connects as the `postgres` SUPERUSER, which BYPASSES
 * every GRANT/REVOKE — the privilege can only be observed through a non-
 * superuser effective role. Creating our own role also makes the assertion
 * independent of whether the Vault DB bootstrap (manual/vault-admin-bootstrap.sql)
 * has been applied in the target environment.
 *
 * No DELETE / DROP / TRUNCATE is ever executed: every mutation runs inside a
 * transaction that is ROLLED BACK, and `SET LOCAL ROLE` auto-resets on rollback.
 * The throwaway role is created idempotently and intentionally left in place
 * (dropping a role is out of scope for this data-layer test).
 *
 * Excluded from `pnpm test:unit` (the `*.postgres.test.ts` suffix) because it
 * needs a live Postgres with this migration applied. Run it explicitly with:
 *   pnpm --filter @arcaai/database exec vitest run --config vitest.worm.config.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/hope';
const TABLE = 'core."HarnessAuditEvent"';
const TEST_ROLE = 'worm_test_role';

let admin: pg.Client;
/** False when no live DB / migration is reachable — the suite then self-skips. */
let available = false;

/** Build a complete, valid INSERT for one append-only audit row. */
function insertEventSql(): { sql: string; params: unknown[] } {
  const id = randomUUID();
  const hash = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const sql = `INSERT INTO ${TABLE}
    ("id","tenantId","consultationId","action","modelName","modelVersion","sensorScores","citations","prevHash","hash")
    VALUES ($1,$2,$3,$4::core."HarnessAuditAction",$5,$6,$7::jsonb,$8::jsonb,$9,$10)`;
  const params = [id, 'worm-test-tenant', 'worm-test-consultation', 'GENERATE', 'test-model', 'v1', '{}', '[]', '0'.repeat(64), hash];
  return { sql, params };
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await admin.connect();
  } catch {
    available = false;
    return;
  }

  const exists = await admin.query(`SELECT to_regclass('core."HarnessAuditEvent"') AS tbl`);
  if (!exists.rows[0]?.tbl) {
    available = false;
    return;
  }

  // Idempotent throwaway role (NOLOGIN — we reach it via SET LOCAL ROLE).
  await admin.query(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${TEST_ROLE}') THEN
        CREATE ROLE ${TEST_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
      END IF;
    END
  $$;`);

  // Grant the full DML a real app role would receive from the bootstrap's
  // ALTER DEFAULT PRIVILEGES, then apply the migration's exact WORM revoke.
  await admin.query(`GRANT USAGE ON SCHEMA core TO ${TEST_ROLE}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO ${TEST_ROLE}`);
  await admin.query(`REVOKE UPDATE, DELETE ON ${TABLE} FROM ${TEST_ROLE}`);

  available = true;
});

afterAll(async () => {
  if (admin) {
    try {
      await admin.query('RESET ROLE');
    } catch {
      /* ignore */
    }
    await admin.end();
  }
});

describe('HarnessAuditEvent WORM enforcement (REVOKE UPDATE, DELETE)', () => {
  it('grants SELECT + INSERT but NOT UPDATE / DELETE to the app role', (ctx) => {
    if (!available) return ctx.skip();
    return (async () => {
      const r = await admin.query(
        `SELECT
           has_table_privilege($1, $2, 'SELECT') AS sel,
           has_table_privilege($1, $2, 'INSERT') AS ins,
           has_table_privilege($1, $2, 'UPDATE') AS upd,
           has_table_privilege($1, $2, 'DELETE') AS del`,
        [TEST_ROLE, 'core."HarnessAuditEvent"'],
      );
      expect(r.rows[0]).toEqual({ sel: true, ins: true, upd: false, del: false });
    })();
  });

  it('allows INSERT as the app role (append is permitted)', (ctx) => {
    if (!available) return ctx.skip();
    return (async () => {
      const { sql, params } = insertEventSql();
      await admin.query('BEGIN');
      try {
        await admin.query(`SET LOCAL ROLE ${TEST_ROLE}`);
        await expect(admin.query(sql, params)).resolves.toMatchObject({ rowCount: 1 });
      } finally {
        await admin.query('ROLLBACK');
      }
    })();
  });

  it('allows SELECT as the app role (read is permitted)', (ctx) => {
    if (!available) return ctx.skip();
    return (async () => {
      await admin.query('BEGIN');
      try {
        await admin.query(`SET LOCAL ROLE ${TEST_ROLE}`);
        const r = await admin.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
        expect(typeof r.rows[0].n).toBe('number');
      } finally {
        await admin.query('ROLLBACK');
      }
    })();
  });

  it('REJECTS UPDATE of an existing row (permission denied, append-only)', (ctx) => {
    if (!available) return ctx.skip();
    return (async () => {
      const { sql, params } = insertEventSql();
      const rowId = params[0];
      await admin.query('BEGIN');
      try {
        // Seed a real, matching row as the superuser inside the txn so the
        // UPDATE below targets an actual row — proving the rejection is a
        // privilege check, not a "no rows matched" no-op.
        await admin.query(sql, params);
        await admin.query(`SET LOCAL ROLE ${TEST_ROLE}`);
        await expect(admin.query(`UPDATE ${TABLE} SET "modelName" = 'tampered' WHERE id = $1`, [rowId])).rejects.toMatchObject({ code: '42501' });
      } finally {
        // The failed UPDATE aborts the txn; ROLLBACK both discards the seed row
        // (no DELETE needed) and resets the LOCAL role.
        await admin.query('ROLLBACK');
      }
    })();
  });

  it('REJECTS DELETE of an existing row (permission denied, append-only)', (ctx) => {
    if (!available) return ctx.skip();
    return (async () => {
      const { sql, params } = insertEventSql();
      const rowId = params[0];
      await admin.query('BEGIN');
      try {
        await admin.query(sql, params);
        await admin.query(`SET LOCAL ROLE ${TEST_ROLE}`);
        await expect(admin.query(`DELETE FROM ${TABLE} WHERE id = $1`, [rowId])).rejects.toMatchObject({ code: '42501' });
      } finally {
        await admin.query('ROLLBACK');
      }
    })();
  });

  it('has REVOKEd UPDATE / DELETE from the real app roles when present (migration effect)', (ctx) => {
    if (!available) return ctx.skip();
    return (async () => {
      for (const role of ['hope_app_template', 'hope_app']) {
        const exists = await admin.query(`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1`, [role]);
        if (exists.rowCount === 0) continue;
        const r = await admin.query(
          `SELECT
             has_table_privilege($1, $2, 'UPDATE') AS upd,
             has_table_privilege($1, $2, 'DELETE') AS del`,
          [role, 'core."HarnessAuditEvent"'],
        );
        expect(r.rows[0].upd, `${role} must not hold UPDATE on HarnessAuditEvent`).toBe(false);
        expect(r.rows[0].del, `${role} must not hold DELETE on HarnessAuditEvent`).toBe(false);
      }
    })();
  });
});
