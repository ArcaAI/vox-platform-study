/**
 * Pipeline template lineage migrations.
 *
 * Two migrations back the lineage feature:
 *   1. `_task_531_pipeline_template_lineage`          — schema (2 columns + index)
 *   2. `_task_531_pipeline_template_lineage_backfill` — data (lock pristine copies)
 *
 * The backfill cannot import TypeScript, so it inlines the 9 template slugs as a
 * SQL literal list. This suite is the drift gate for that duplication: the SQL
 * list must set-equal the exported `ASR_TEMPLATE_SLUGS` seed constant, and the
 * backfill must keep the "pristine-only" double predicate that stops it locking
 * a pipeline a tenant already customized (README §3.3).
 *
 * Precedent: `role-consolidation-migration.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { ASR_TEMPLATE_SLUGS } from '../prisma/db_main/seed/06-stt';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'db_main', 'migrations');

const SCHEMA_SUFFIX = '_task_531_pipeline_template_lineage';
const BACKFILL_SUFFIX = '_task_531_pipeline_template_lineage_backfill';

function findMigrationDir(suffix: string): string | undefined {
  if (!existsSync(MIGRATIONS_DIR)) return undefined;
  return readdirSync(MIGRATIONS_DIR).find((name) => name.endsWith(suffix));
}

function readMigrationSql(suffix: string): string {
  const dir = findMigrationDir(suffix);
  if (!dir) throw new Error(`TASK-531 migration (*${suffix}) not found`);
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

describe('pipeline template lineage — schema migration', () => {
  it('exists as a timestamped Prisma migration', () => {
    const dir = findMigrationDir(SCHEMA_SUFFIX);
    expect(dir).toBeDefined();
    expect(dir).toMatch(/^\d{14}_task_531_pipeline_template_lineage$/);
  });

  it('adds both lineage columns to core."AsrPipeline"', () => {
    const sql = stripSqlComments(readMigrationSql(SCHEMA_SUFFIX));
    expect(sql).toMatch(/ADD COLUMN[^;]*"sourceTemplateSlug"\s+TEXT/i);
    expect(sql).toMatch(/ADD COLUMN[^;]*"templateLocked"\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+false/i);
  });

  it('creates the tenant+locked scan index used by resync/backfill', () => {
    const sql = stripSqlComments(readMigrationSql(SCHEMA_SUFFIX));
    expect(sql).toMatch(/CREATE INDEX[^;]*"AsrPipeline_tenant_locked_idx"/i);
  });

  it('is additive only — never drops or truncates', () => {
    const sql = stripSqlComments(readMigrationSql(SCHEMA_SUFFIX));
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(sql).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM)\b/i);
  });
});

describe('pipeline template lineage — backfill migration', () => {
  it('exists as a timestamped Prisma migration', () => {
    const dir = findMigrationDir(BACKFILL_SUFFIX);
    expect(dir).toBeDefined();
    expect(dir).toMatch(/^\d{14}_task_531_pipeline_template_lineage_backfill$/);
  });

  it('inlines the frozen TASK-531 template set, all still real templates', () => {
    const sql = stripSqlComments(readMigrationSql(BACKFILL_SUFFIX));

    // The slug list is declared exactly once, as the `template_slugs` ARRAY[…]
    // literal. Reading only that block keeps unrelated string literals in the
    // migration (enum values, NOTICE text) out of the comparison.
    const arrayBlock = sql.match(/template_slugs[^:]*:=\s*ARRAY\s*\[([^\]]*)\]/i);
    expect(arrayBlock).not.toBeNull();

    const slugsInSql = (arrayBlock![1].match(/'([^']+)'/g) ?? []).map((s) => s.slice(1, -1));

    // The 531 backfill is HISTORICAL: it locked clones of the templates that
    // existed when it shipped (the frozen 9). A tenant could not have cloned a
    // template before it existed, so post-531 additions (e.g. the TASK-567
    // sarvam/openai fallback templates) are deliberately NOT in this migration's
    // literal — and the committed migration SQL is immutable. The drift gate is
    // therefore: the migration inlines exactly its frozen 9, and every one of
    // them is still a real exported template (a removal would break this).
    expect(slugsInSql).toHaveLength(9);
    slugsInSql.forEach((slug) => expect(ASR_TEMPLATE_SLUGS).toContain(slug));
  });

  it('never locks SYSTEM-owned rows (the templates themselves)', () => {
    const sql = stripSqlComments(readMigrationSql(BACKFILL_SUFFIX));
    // The SYSTEM tenant id is bound once and every candidate predicate excludes it.
    expect(sql).toMatch(/system_tenant\s+CONSTANT\s+TEXT\s*:=\s*'00000000-0000-0000-0000-000000000000'/i);
    const exclusions = sql.match(/"tenantId"\s*<>\s*system_tenant/gi) ?? [];
    // One per candidate scan: provenance, lock, ambiguous-report.
    expect(exclusions.length).toBeGreaterThanOrEqual(3);
  });

  it('locks only pristine copies — slug match AND config equality (README §3.3)', () => {
    const sql = stripSqlComments(readMigrationSql(BACKFILL_SUFFIX));
    // Predicate (a): slug is one of the templates.
    expect(sql).toMatch(/"slug"\s*=\s*ANY\(template_slugs\)/i);
    // Predicate (b): the row's YAML still equals its clone-time v1 snapshot…
    expect(sql).toMatch(/"AsrPipelineVersion"/);
    expect(sql).toMatch(/p\."configYaml"\s*=\s*ct\.config_yaml/i);
    // …or, when the row has no version history, the SYSTEM row's current YAML.
    expect(sql).toMatch(/p\."configYaml"\s*=\s*sc\.config_yaml/i);
    // The lock UPDATE must be gated on that pristine set, never on slug alone.
    expect(sql).toMatch(/SET\s+"templateLocked"\s*=\s*true\s+FROM\s+pristine/i);
  });

  it('reports ambiguous rows instead of locking them', () => {
    const sql = readMigrationSql(BACKFILL_SUFFIX);
    expect(sql).toMatch(/RAISE NOTICE/i);
  });

  it('is data-only — never drops or truncates', () => {
    const sql = stripSqlComments(readMigrationSql(BACKFILL_SUFFIX));
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(sql).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM)\b/i);
  });
});
