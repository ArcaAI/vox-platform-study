/**
 * TASK-932 S1-1 — pin the hand-authored `(tenantId, key)` uniqueness
 * migration against the schema it must agree with.
 *
 * This is a text-level pin (no database, no Prisma client) in the same
 * idiom as `storage-config-secrets-migration.test.ts` — it reads the source
 * files directly and regex-checks them, because the property under test
 * ("the dedupe runs before the index" / "the index name matches the
 * schema") is about the SQL FILE'S shape, not runtime behavior.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../prisma/db_main/migrations/20260909020000_task_932_global_setting_tenant_key_unique/migration.sql'),
  'utf8',
);
const SCHEMA = readFileSync(resolve(__dirname, '../prisma/db_main/globalSetting.prisma'), 'utf8');

describe('TASK-932 migration: GlobalSetting (tenantId, key) uniqueness', () => {
  it('the schema declares the new unique constraint with a `map:`, not a `name:`', () => {
    // The exact trap `02-database-prisma.md` calls out: `name:` never reaches
    // Postgres. Asserting `map:` here is what stops this migration from
    // repeating the `GlobalSetting_tenantId_name_key_unique` /
    // `..._key_key` mismatch on its own sibling constraint.
    expect(SCHEMA).toMatch(/@@unique\(\[tenantId, key\], map: "GlobalSetting_tenantId_key_unique"\)/);
  });

  it('the migration creates a unique index named exactly what the schema declares', () => {
    const mapMatch = SCHEMA.match(/@@unique\(\[tenantId, key\], map: "([^"]+)"\)/);
    expect(mapMatch, 'schema map: value must be extractable').not.toBeNull();
    const indexName = mapMatch![1];

    const createIndexRegex = new RegExp(`CREATE UNIQUE INDEX "${indexName}" ON "core"\\."GlobalSetting"\\("tenantId", "key"\\)`);
    expect(MIGRATION_SQL).toMatch(createIndexRegex);
  });

  it('the index is non-partial (no WHERE clause) — consistent with the sibling (tenantId, name, key) constraint', () => {
    const createIndexLine = MIGRATION_SQL.split('\n').find((line) => line.includes('CREATE UNIQUE INDEX "GlobalSetting_tenantId_key_unique"'));
    expect(createIndexLine).toBeDefined();
    expect(createIndexLine).not.toMatch(/WHERE/i);
  });

  it('the dedupe (soft-delete) statement runs BEFORE the CREATE UNIQUE INDEX statement', () => {
    // Creating the index while duplicates exist would fail outright, so this
    // is load-bearing for the migration actually applying — not just style.
    const dedupeIndex = MIGRATION_SQL.indexOf('SET "resourceStatus" = \'DELETED\'');
    const createIndexIndex = MIGRATION_SQL.indexOf('CREATE UNIQUE INDEX "GlobalSetting_tenantId_key_unique"');

    expect(dedupeIndex).toBeGreaterThan(-1);
    expect(createIndexIndex).toBeGreaterThan(-1);
    expect(dedupeIndex).toBeLessThan(createIndexIndex);
  });

  it('the dedupe is an UPDATE (soft delete), never a hard delete of any kind', () => {
    // Scan actual SQL statements only, not the header comment (which
    // legitimately NAMES "DELETE"/"TRUNCATE" while explaining they are
    // forbidden) — a bare substring/word-boundary match against the whole
    // file would flag its own explanatory prose as the violation it warns
    // against.
    const sqlOnly = MIGRATION_SQL.split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(sqlOnly).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sqlOnly).not.toMatch(/\bTRUNCATE\b/i);
    expect(sqlOnly).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
  });

  it("the dedupe keeps the `registry` namespace row first, then the oldest createdAt, per the write lane's own adoption policy", () => {
    expect(MIGRATION_SQL).toMatch(/PARTITION BY "tenantId", "key"/);
    expect(MIGRATION_SQL).toMatch(/ORDER BY \("namespace" = 'registry'\) DESC, "createdAt" ASC, "id" ASC/);
  });

  it('only LIVE rows are ranked for the dedupe (an already-deleted row never blocks a survivor)', () => {
    expect(MIGRATION_SQL).toMatch(/WHERE "resourceStatus" != 'DELETED'/);
  });
});
