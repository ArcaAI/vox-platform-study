/**
 * Structural guard for the SUPER_ADMIN → GLOBAL_ADMIN role
 * consolidation data migration.
 *
 * The migration is a pure data migration (no DDL) and applying it requires a
 * live Postgres, so — like `phase-f-backfill-migration.test.ts` — we do NOT
 * execute it here. Instead we lock down the STRUCTURE that proves the
 * acceptance criteria:
 *
 *   1. NON-DESTRUCTIVE — no `DELETE` / `DROP` / `TRUNCATE`; retiring rows is
 *      a SOFT delete (`UPDATE … SET "resourceStatus" = 'DELETED'`), per the
 *      platform soft-delete convention.
 *   2. IDEMPOTENT — every INSERT is guarded by `ON CONFLICT … DO NOTHING`
 *      against the table's natural unique key, and every UPDATE excludes
 *      already-DELETED rows, so a re-run is a no-op.
 *   3. COMPLETE — GLOBAL_ADMIN inherits every policy attachment SUPER_ADMIN
 *      had (RolePolicy copy), every live SUPER_ADMIN user-role assignment is
 *      reassigned to GLOBAL_ADMIN preserving its tenant, and only then are
 *      the SUPER_ADMIN assignments and the SUPER_ADMIN role row soft-retired.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'prisma',
  'db_main',
  'migrations',
);

const MIGRATION_SUFFIX = '_task_417_consolidate_super_admin_into_global_admin';

function findMigrationDir(): string | undefined {
  if (!existsSync(MIGRATIONS_DIR)) return undefined;
  return readdirSync(MIGRATIONS_DIR).find((name) => name.endsWith(MIGRATION_SUFFIX));
}

function readMigrationSql(): string {
  const dir = findMigrationDir();
  if (!dir) throw new Error(`TASK-417 consolidation migration (*${MIGRATION_SUFFIX}) not found`);
  return readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8');
}

/** Strip `-- …` comments (full-line and inline) so prose can mention keywords. */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

describe('TASK-417 role-consolidation migration', () => {
  it('exists as a timestamped Prisma migration', () => {
    const dir = findMigrationDir();
    expect(dir).toBeDefined();
    expect(dir).toMatch(/^\d{14}_task_417_consolidate_super_admin_into_global_admin$/);
  });

  it('has a non-empty migration.sql', () => {
    const sql = readMigrationSql();
    expect(sql.trim().length).toBeGreaterThan(0);
  });

  describe('non-destructive (soft delete only — no DELETE / DROP / TRUNCATE)', () => {
    it('contains no hard-destructive statements outside comments', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(code).not.toMatch(/\bDROP\b/i);
      expect(code).not.toMatch(/\bTRUNCATE\b/i);
    });

    it('retires rows via soft delete (UPDATE … resourceStatus = DELETED) only', () => {
      const code = stripSqlComments(readMigrationSql());
      const updates = code.match(/\bUPDATE\s+core\."/gi) ?? [];
      const softDeletes = code.match(/"resourceStatus"\s*=\s*'DELETED'/gi) ?? [];
      // Exactly two UPDATE statements: the SUPER_ADMIN assignments and the
      // SUPER_ADMIN role row — both soft deletes.
      expect(updates.length).toBe(2);
      expect(softDeletes.length).toBeGreaterThanOrEqual(updates.length);
    });

    it('bumps the optimistic-concurrency counter on soft-deleted rows', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).toMatch(/"_version"\s*=\s*"_version"\s*\+\s*1/i);
    });
  });

  describe('idempotent (insert-if-absent, update-if-not-yet-deleted)', () => {
    it('guards every INSERT with ON CONFLICT DO NOTHING', () => {
      const code = stripSqlComments(readMigrationSql());
      const inserts = code.match(/INSERT\s+INTO/gi) ?? [];
      const conflicts = code.match(/ON\s+CONFLICT/gi) ?? [];
      const doNothing = code.match(/DO\s+NOTHING/gi) ?? [];
      expect(inserts.length).toBeGreaterThanOrEqual(2);
      expect(conflicts.length).toBeGreaterThanOrEqual(inserts.length);
      expect(doNothing.length).toBeGreaterThanOrEqual(inserts.length);
    });

    it('copies role→policy attachments guarded on the (roleId, policyId) unique key', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).toMatch(/INSERT\s+INTO\s+core\."RolePolicy"/i);
      expect(code).toMatch(/ON\s+CONFLICT\s*\(\s*"roleId"\s*,\s*"policyId"\s*\)\s*DO\s+NOTHING/i);
    });

    it('reassigns user-role assignments guarded on the (userId, roleId, tenantId) unique key', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).toMatch(/INSERT\s+INTO\s+core\."UserRoleAssignment"/i);
      expect(code).toMatch(
        /ON\s+CONFLICT\s*\(\s*"userId"\s*,\s*"roleId"\s*,\s*"tenantId"\s*\)\s*DO\s+NOTHING/i,
      );
    });

    it('excludes already-DELETED rows from both soft-delete UPDATEs (re-run is a no-op)', () => {
      const code = stripSqlComments(readMigrationSql());
      const guards = code.match(/"resourceStatus"\s*<>\s*'DELETED'/gi) ?? [];
      expect(guards.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('correctness (consolidation semantics)', () => {
    it('scopes every mutation to the SUPER_ADMIN role by name', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).toMatch(/'SUPER_ADMIN'/);
    });

    it('targets GLOBAL_ADMIN as the canonical consolidated role', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).toMatch(/'GLOBAL_ADMIN'/);
    });

    it('preserves the tenant of each reassigned user-role assignment', () => {
      const code = stripSqlComments(readMigrationSql());
      // The UserRoleAssignment INSERT must carry tenantId through from the
      // source SUPER_ADMIN assignment — never hardcode a tenant.
      expect(code).toMatch(/INSERT\s+INTO\s+core\."UserRoleAssignment"[\s\S]*?"tenantId"/i);
    });
  });
});
