/**
 * TASK-810 / OD-13 — `DocumentTemplateVersion` immutability guard, proven
 * against live Postgres.
 *
 * The migration `…_task_810_document_template_catalog` installs
 * `core.document_template_version_immutability_guard()` behind a
 * `BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger, so a published clinical
 * template shape cannot be rewritten underneath the consultations pinned to it.
 * The `ConsultationContextSchemaVersion` precedent this catalog copies has NO
 * such guard — its version rows are immutable by CONVENTION only (the
 * repository exposes `.create()`/`.find*()` and nothing else). OD-13 says
 * convention is not enough here, so this suite proves the DB half actually
 * fires rather than merely existing in a migration file.
 *
 * WHY THE DDL IS SOURCED FROM THE MIGRATION FILE. Two reasons, and they are
 * the same two that make `harness-audit-worm.postgres.test.ts` re-apply its
 * migration's `REVOKE` in `beforeAll`:
 *
 *   1. The local dev database is `db push`-managed and has no migrations
 *      ledger (02-database-prisma.md). `db push` reproduces TABLES from the
 *      Prisma schema and nothing else — a trigger is not expressible in the
 *      Prisma DSL, so a dev DB simply does not have it. A test that assumed
 *      otherwise would fail for everyone locally.
 *   2. Executing the COMMITTED bytes means this suite fails if someone deletes
 *      or weakens the guard in the migration, which a hand-retyped copy of the
 *      DDL inside the test would not catch.
 *
 * Excluded from `pnpm test:unit` (the `*.postgres.test.ts` suffix). Run it with:
 *   pnpm --filter @arcaai/database exec vitest run --config vitest.worm.config.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/hope';
const TEMPLATE_TABLE = 'core."DocumentTemplate"';
const VERSION_TABLE = 'core."DocumentTemplateVersion"';
const MIGRATIONS_DIR = join(__dirname, '..', 'prisma', 'db_main', 'migrations');

/** SQLSTATE for `restrict_violation` — what the guard raises `USING ERRCODE`. */
const RESTRICT_VIOLATION = '23001';

let admin: pg.Client;
/** False when no live DB / table is reachable — the suite then self-skips. */
let available = false;

/**
 * The guard's DDL, read out of the committed migration. Everything from the
 * `CREATE OR REPLACE FUNCTION` line to the end of the file — the trigger and
 * its function are the only statements in that trailing block.
 */
function guardDdlFromMigration(): string {
  const dir = readdirSync(MIGRATIONS_DIR).find((name) => name.endsWith('_task_810_document_template_catalog'));
  if (!dir) throw new Error('TASK-810 migration folder not found — was the migration renamed or deleted?');
  const sql = readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8');
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION "core"."document_template_version_immutability_guard"');
  if (start < 0) {
    throw new Error('The OD-13 immutability guard is missing from the TASK-810 migration.');
  }
  return sql.slice(start);
}

/** A complete, valid template head + one published version row. */
function seedSql(): { templateId: string; versionId: string; statements: Array<{ sql: string; params: unknown[] }> } {
  const templateId = randomUUID();
  const versionId = randomUUID();
  const tenantId = randomUUID();
  return {
    templateId,
    versionId,
    statements: [
      {
        sql: `INSERT INTO ${TEMPLATE_TABLE} ("id","tenantId","slug","name","updatedAt") VALUES ($1,$2,$3,$4, now())`,
        params: [templateId, tenantId, `t_${templateId.slice(0, 8)}`, 'Immutability probe'],
      },
      {
        sql: `INSERT INTO ${VERSION_TABLE} ("id","tenantId","templateId","versionNumber","shape","compiled","compilerVersion","checksum")
              VALUES ($1,$2,$3,1,$4::jsonb,$5::jsonb,$6,$7)`,
        params: [versionId, tenantId, templateId, '{"schemaVersion":"1.0"}', '{}', '1.0.0', 'deadbeef'],
      },
    ],
  };
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await admin.connect();
  } catch {
    available = false;
    return;
  }

  const exists = await admin.query(`SELECT to_regclass('core."DocumentTemplateVersion"') AS tbl`);
  if (!exists.rows[0]?.tbl) {
    available = false;
    return;
  }

  // Idempotently install the COMMITTED guard (see the header: a `db push` dev
  // DB has the tables but never the trigger).
  await admin.query(`DROP TRIGGER IF EXISTS "document_template_version_immutability_guard_trigger" ON ${VERSION_TABLE}`);
  await admin.query(guardDdlFromMigration());

  available = true;
});

afterAll(async () => {
  if (admin) {
    await admin.end();
  }
});

describe('TASK-810 OD-13 — DocumentTemplateVersion immutability guard', () => {
  it('permits INSERT of a new version row (publishing mints, it does not edit)', (ctx) => {
    if (!available) return ctx.skip();
    return (async () => {
      const { statements } = seedSql();
      await admin.query('BEGIN');
      try {
        for (const statement of statements) {
          await expect(admin.query(statement.sql, statement.params)).resolves.toMatchObject({ rowCount: 1 });
        }
      } finally {
        await admin.query('ROLLBACK');
      }
    })();
  });

  it('REJECTS an UPDATE of the published shape on a real row', (ctx) => {
    if (!available) return ctx.skip();
    return (async () => {
      const { versionId, statements } = seedSql();
      await admin.query('BEGIN');
      try {
        // Seed a REAL row first, so the rejection below is provably the guard
        // firing and not a "no rows matched" no-op.
        for (const statement of statements) await admin.query(statement.sql, statement.params);
        await expect(
          admin.query(`UPDATE ${VERSION_TABLE} SET "shape" = '{"schemaVersion":"1.0","tampered":true}'::jsonb WHERE id = $1`, [versionId]),
        ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
      } finally {
        await admin.query('ROLLBACK');
      }
    })();
  });

  it('REJECTS an UPDATE even of a column the application never writes (unconditional, not column-gated)', (ctx) => {
    if (!available) return ctx.skip();
    return (async () => {
      const { versionId, statements } = seedSql();
      await admin.query('BEGIN');
      try {
        for (const statement of statements) await admin.query(statement.sql, statement.params);
        // `changeReason` is free-text provenance, the least load-bearing column
        // on the row. The WorkflowDefinition guard is column-gated and would
        // ALLOW this; this one must not, because unlike that table there is no
        // legitimate in-place write here to preserve.
        await expect(admin.query(`UPDATE ${VERSION_TABLE} SET "changeReason" = 'retconned' WHERE id = $1`, [versionId])).rejects.toMatchObject({
          code: RESTRICT_VIOLATION,
        });
      } finally {
        await admin.query('ROLLBACK');
      }
    })();
  });

  it('REJECTS a hard DELETE of a published version row', (ctx) => {
    if (!available) return ctx.skip();
    return (async () => {
      const { versionId, statements } = seedSql();
      await admin.query('BEGIN');
      try {
        for (const statement of statements) await admin.query(statement.sql, statement.params);
        await expect(admin.query(`DELETE FROM ${VERSION_TABLE} WHERE id = $1`, [versionId])).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
      } finally {
        await admin.query('ROLLBACK');
      }
    })();
  });

  it('leaves the MUTABLE head row writable — the pin has to be able to move', (ctx) => {
    if (!available) return ctx.skip();
    return (async () => {
      const { templateId, statements } = seedSql();
      await admin.query('BEGIN');
      try {
        for (const statement of statements) await admin.query(statement.sql, statement.params);
        // The guard is on the VERSION table only. If it ever leaked onto the
        // head, publishing could never move `pinnedVersionNumber` and the whole
        // catalog would be write-once.
        await expect(
          admin.query(`UPDATE ${TEMPLATE_TABLE} SET "pinnedVersionNumber" = 1, "updatedAt" = now() WHERE id = $1`, [templateId]),
        ).resolves.toMatchObject({ rowCount: 1 });
      } finally {
        await admin.query('ROLLBACK');
      }
    })();
  });
});
