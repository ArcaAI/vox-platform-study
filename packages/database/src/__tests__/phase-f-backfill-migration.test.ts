/**
 * Structural guard for the user↔department back-fill migration.
 *
 * The migration is a pure data migration (no DDL) and applying it requires a
 * live Postgres, so — like `backfill-globalsetting-encryption.test.ts` keeps
 * its `main()` loop integration-only — we do NOT execute it here. Instead we
 * lock down the STRUCTURE that proves the two acceptance criteria:
 *
 *   1. IDEMPOTENT  — every write is an `INSERT ... ON CONFLICT ... DO NOTHING`
 *      (find-or-create / insert-if-absent) and the candidate set excludes
 *      anyone who already holds the department half, so a re-run is a no-op.
 *   2. NON-DESTRUCTIVE — no `DELETE` / `DROP` / `TRUNCATE` / `UPDATE`; the
 *      migration only ever INSERTs (existing rows are never touched).
 *
 * Plus the correctness invariants that mirror `tenant-guards.ts`
 * (`assertUserBelongsToTenant`) and the seed (`91-user.ts`): it targets only
 * NON-EXEMPT role-only memberships — service accounts are excluded, the
 * reserved SUPER_ADMIN role and the reserved SYSTEM tenant are excluded — and
 * creates a PRIMARY `UserDepartment` against a find-or-created `GEN`
 * department.
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

const MIGRATION_SUFFIX = '_task_305_phase_f_backfill_user_department';

/** Reserved seed ids the migration must treat as exempt (login-exempt operators). */
const SUPER_ADMIN_ROLE_ID = '00000000-0000-0000-0000-000000000001';
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

function findMigrationDir(): string | undefined {
  if (!existsSync(MIGRATIONS_DIR)) return undefined;
  return readdirSync(MIGRATIONS_DIR).find((name) => name.endsWith(MIGRATION_SUFFIX));
}

function readMigrationSql(): string {
  const dir = findMigrationDir();
  if (!dir) throw new Error(`Phase F back-fill migration (*${MIGRATION_SUFFIX}) not found`);
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

describe('TASK-305 Phase F (F.6) back-fill migration', () => {
  it('exists as a timestamped Prisma migration', () => {
    const dir = findMigrationDir();
    expect(dir).toBeDefined();
    // Prisma orders migrations lexicographically by the leading timestamp.
    expect(dir).toMatch(/^\d{14}_task_305_phase_f_backfill_user_department$/);
  });

  it('has a non-empty migration.sql', () => {
    const sql = readMigrationSql();
    expect(sql.trim().length).toBeGreaterThan(0);
  });

  describe('non-destructive (constraint: no DELETE / DROP / TRUNCATE / UPDATE)', () => {
    it('contains no destructive or mutating statements outside comments', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).not.toMatch(/\bDELETE\b/i);
      expect(code).not.toMatch(/\bDROP\b/i);
      expect(code).not.toMatch(/\bTRUNCATE\b/i);
      // Variant A is INSERT-only: even pre-existing rows are never mutated.
      expect(code).not.toMatch(/\bUPDATE\b/i);
    });
  });

  describe('idempotent (insert-if-absent only)', () => {
    it('guards every INSERT with ON CONFLICT DO NOTHING', () => {
      const code = stripSqlComments(readMigrationSql());
      const inserts = code.match(/INSERT\s+INTO/gi) ?? [];
      const conflicts = code.match(/ON\s+CONFLICT/gi) ?? [];
      const doNothing = code.match(/DO\s+NOTHING/gi) ?? [];
      expect(inserts.length).toBeGreaterThanOrEqual(2);
      expect(conflicts.length).toBeGreaterThanOrEqual(inserts.length);
      expect(doNothing.length).toBeGreaterThanOrEqual(inserts.length);
    });

    it('find-or-creates the GEN department (ON CONFLICT (tenantId, code) DO NOTHING)', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).toMatch(/INSERT\s+INTO\s+core\."Department"/i);
      // `code` may be written quoted or bare (folds to lowercase either way).
      expect(code).toMatch(/ON\s+CONFLICT\s*\(\s*"tenantId"\s*,\s*"?code"?\s*\)\s*DO\s+NOTHING/i);
    });

    it('guards the UserDepartment INSERT on its tenant/user/department unique key', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).toMatch(/INSERT\s+INTO\s+core\."UserDepartment"/i);
      expect(code).toMatch(
        /ON\s+CONFLICT\s*\(\s*"tenantId"\s*,\s*"userId"\s*,\s*"departmentId"\s*\)\s*DO\s+NOTHING/i,
      );
    });

    it('excludes already-fixed members via NOT EXISTS on an ENABLED UserDepartment', () => {
      const code = stripSqlComments(readMigrationSql());
      // Re-run safety: the candidate set drops anyone who already has the
      // department half, so a second apply inserts nothing new.
      expect(code).toMatch(/NOT\s+EXISTS/i);
      expect(code).toMatch(/core\."UserDepartment"/i);
    });
  });

  describe('correctness (only NON-EXEMPT role-only memberships)', () => {
    it('requires an ENABLED role assignment', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).toMatch(/core\."UserRoleAssignment"/i);
      expect(code).toMatch(/'ENABLED'/);
    });

    it('excludes service accounts (User.isServiceAccount = false)', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).toMatch(/"isServiceAccount"\s*=\s*false/i);
    });

    it('excludes the reserved SUPER_ADMIN role (global, login-exempt operators)', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).toMatch(new RegExp(`"roleId"\\s*<>\\s*'${SUPER_ADMIN_ROLE_ID}'`, 'i'));
    });

    it('excludes the reserved SYSTEM tenant (platform-wide assignments, not memberships)', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).toMatch(new RegExp(`"tenantId"\\s*<>\\s*'${SYSTEM_TENANT_ID}'`, 'i'));
    });

    it('creates a PRIMARY GEN department link', () => {
      const code = stripSqlComments(readMigrationSql());
      expect(code).toMatch(/"isPrimary"/i);
      expect(code).toMatch(/'GEN'/);
    });
  });
});
