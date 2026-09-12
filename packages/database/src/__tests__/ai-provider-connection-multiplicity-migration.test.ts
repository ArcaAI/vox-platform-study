/**
 * TASK-958 (test 1) — pin the STATEMENT ORDER of the multiplicity migration.
 *
 * Prisma's own draft for this schema change was
 * `ALTER TABLE ... ADD COLUMN "slug" TEXT NOT NULL` with no backfill, which
 * cannot run against a non-empty table. The committed SQL is hand-ordered —
 * nullable add, backfill, SET NOT NULL, drop the old unique, create the two new
 * ones — and NOTHING except this test notices if a future `prisma migrate dev`
 * regenerates the file and silently restores the draft. That is the whole point
 * of the suite: the property under test is the shape of the SQL FILE, so it is a
 * text-level pin with no database and no Prisma client, in the same idiom as
 * `global-setting-tenant-key-migration.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../prisma/db_main/migrations/20260912123256_task_958_provider_connection_multiplicity/migration.sql'),
  'utf8',
);
const SCHEMA = readFileSync(resolve(__dirname, '../prisma/db_main/ai-provider-connection.prisma'), 'utf8');
const LEDGER_SCHEMA = readFileSync(resolve(__dirname, '../prisma/db_main/usage-ledger.prisma'), 'utf8');

/** SQL statements only — the header comment legitimately NAMES statements it explains. */
const SQL_ONLY = MIGRATION_SQL.split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

/** Position of the first match, or -1. Used for ordering assertions. */
const at = (pattern: RegExp): number => {
  const m = SQL_ONLY.match(pattern);
  return m?.index ?? -1;
};

const ADD_COLUMNS = /ALTER TABLE "core"\."AiProviderConnection" ADD COLUMN/;
const BACKFILL = /UPDATE "core"\."AiProviderConnection"/;
const SET_NOT_NULL = /ALTER COLUMN "slug" SET NOT NULL/;
const DROP_OLD_UNIQUE = /DROP INDEX "core"\."AiProviderConnection_tenantId_service_provider_key"/;
const CREATE_SLUG_UNIQUE = /CREATE UNIQUE INDEX "AiProviderConnection_tenant_service_slug_key"/;
const CREATE_DEFAULT_UNIQUE = /CREATE UNIQUE INDEX "AiProviderConnection_tenant_service_default_key"/;
const USAGE_COLUMN = /ALTER TABLE "core"\."AiUsageEvent" ADD COLUMN\s+"connectionId" TEXT/;
const USAGE_INDEX = /CREATE INDEX "AiUsageEvent_connectionId_idx" ON "core"\."AiUsageEvent"\("connectionId"\)/;

describe('TASK-958 migration: AiProviderConnection multiplicity', () => {
  it('adds `slug` NULLABLE — the generated draft added it NOT NULL and could not run', () => {
    expect(SQL_ONLY).toMatch(/ADD COLUMN\s+"slug" TEXT[,;]/);
    expect(SQL_ONLY, 'a NOT NULL add with no default cannot run on a non-empty table').not.toMatch(/ADD COLUMN\s+"slug" TEXT NOT NULL/);
  });

  it('backfills `slug` and `defaultForProvider` from `provider`', () => {
    // Both halves matter: `slug` is the new identity and `defaultForProvider`
    // is what makes every existing row its provider's default. Backfilling only
    // the first would leave a tenant with no default connection at all, and the
    // provider-name cascade would resolve nothing.
    expect(SQL_ONLY).toMatch(/SET "slug" = "provider"/);
    expect(SQL_ONLY).toMatch(/"defaultForProvider" = "provider"/);
  });

  it('runs in the order: add nullable → backfill → SET NOT NULL', () => {
    // This is the ordering the draft got wrong, and the reason the file is
    // hand-authored.
    expect(at(ADD_COLUMNS)).toBeGreaterThan(-1);
    expect(at(BACKFILL)).toBeGreaterThan(at(ADD_COLUMNS));
    expect(at(SET_NOT_NULL)).toBeGreaterThan(at(BACKFILL));
  });

  it('drops the old (tenantId, service, provider) unique before creating the two new ones', () => {
    expect(at(DROP_OLD_UNIQUE)).toBeGreaterThan(at(SET_NOT_NULL));
    expect(at(CREATE_SLUG_UNIQUE)).toBeGreaterThan(at(DROP_OLD_UNIQUE));
    expect(at(CREATE_DEFAULT_UNIQUE)).toBeGreaterThan(at(DROP_OLD_UNIQUE));
  });

  it('drops the index by its DATABASE name, which the old `name:` never set', () => {
    // The `@@unique(..., name: "AiProviderConnection_tenant_service_provider_unique")`
    // it replaces set the CLIENT-facing compound key; Postgres only ever knew
    // the constraint by Prisma's default `Model_field_field_key` spelling
    // (`02-database-prisma.md` §the `@@unique` `map:` trap). Dropping the
    // `name:` spelling would fail at deploy time with "index does not exist".
    expect(SQL_ONLY).toMatch(DROP_OLD_UNIQUE);
    expect(SQL_ONLY).not.toMatch(/AiProviderConnection_tenant_service_provider_unique/);
  });

  it('adds the ledger attribution column and its index', () => {
    expect(SQL_ONLY).toMatch(USAGE_COLUMN);
    expect(SQL_ONLY).toMatch(USAGE_INDEX);
    expect(at(USAGE_INDEX)).toBeGreaterThan(at(USAGE_COLUMN));
  });

  it('destroys nothing — no hard delete, no dropped table or column', () => {
    expect(SQL_ONLY).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(SQL_ONLY).not.toMatch(/\bTRUNCATE\b/i);
    expect(SQL_ONLY).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
  });
});

describe('TASK-958 schema: the migration and the Prisma schema agree', () => {
  it('declares both uniques with `map:` (the DB index name), never `name:`', () => {
    expect(SCHEMA).toMatch(/@@unique\(\[tenantId, service, slug\], map: "AiProviderConnection_tenant_service_slug_key"\)/);
    expect(SCHEMA).toMatch(/@@unique\(\[tenantId, service, defaultForProvider\], map: "AiProviderConnection_tenant_service_default_key"\)/);
  });

  it('no longer declares the (tenantId, service, provider) unique', () => {
    expect(SCHEMA).not.toMatch(/@@unique\(\[tenantId, service, provider\]/);
  });

  it('keeps the three non-unique indexes the cascade and the admin list read', () => {
    expect(SCHEMA).toMatch(/@@index\(\[tenantId, service\], name: "AiProviderConnection_tenantId_service_idx"\)/);
    expect(SCHEMA).toMatch(/@@index\(\[service, provider\], name: "AiProviderConnection_service_provider_idx"\)/);
    expect(SCHEMA).toMatch(/@@index\(\[provider\], name: "AiProviderConnection_provider_idx"\)/);
  });

  it('declares `slug` required, `name` and `defaultForProvider` optional', () => {
    expect(SCHEMA).toMatch(/^\s+slug\s+String\s*$/m);
    expect(SCHEMA).toMatch(/^\s+name\s+String\?\s*$/m);
    expect(SCHEMA).toMatch(/^\s+defaultForProvider\s+String\?\s*$/m);
  });

  it('declares `AiUsageEvent.connectionId` nullable with no relation — the ledger outlives the connection', () => {
    expect(LEDGER_SCHEMA).toMatch(/^\s+connectionId\s+String\?\s*$/m);
    expect(LEDGER_SCHEMA).toMatch(/@@index\(\[connectionId\], name: "AiUsageEvent_connectionId_idx"\)/);
    expect(LEDGER_SCHEMA).not.toMatch(/connectionId.*@relation/);
  });
});
