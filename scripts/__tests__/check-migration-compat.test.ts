/**
 * Unit tests for the migration backwards-compatibility gate
 *
 * The two narrowings in `scripts/check-migration-compat.ts` are the whole
 * design — `ALTER INDEX … RENAME` and `ALTER TYPE … ADD VALUE` are safe and
 * common in this repo (the latter is REQUIRED by `03-domain-layer.md` for any
 * model emitting sys-events). Both have explicit must-not-fire tests below; if
 * one regresses, the gate starts flagging routine migrations and gets disabled
 * by whoever is on call, which is worse than not having it.
 */
import { describe, expect, it } from 'vitest';

import { evaluate, readReviewAnnotation, scanMigration, splitStatements, stripComments } from '../check-migration-compat';

const scan = (sql: string) => scanMigration('test.sql', sql);
const ruleIds = (sql: string) => scan(sql).findings.map((f) => f.rule);

describe('rules that must fire', () => {
  it.each([
    ['drop-column', 'ALTER TABLE "Consultation" DROP COLUMN "legacyNote";'],
    ['drop-table', 'DROP TABLE "OldAuditLog";'],
    ['rename-table-or-column', 'ALTER TABLE "Consultation" RENAME COLUMN "note" TO "clinicalNote";'],
    ['rename-table-or-column', 'ALTER TABLE "Consultation" RENAME TO "Encounter";'],
    ['alter-column-type', 'ALTER TABLE "Consultation" ALTER COLUMN "durationMs" TYPE BIGINT;'],
    ['set-not-null', 'ALTER TABLE "Consultation" ALTER COLUMN "tenantId" SET NOT NULL;'],
  ])('%s fires', (rule, sql) => {
    expect(ruleIds(sql)).toContain(rule);
  });

  it('reports the line number of the offending statement', () => {
    const sql = ['-- header', 'CREATE INDEX CONCURRENTLY "a_idx" ON "A"("x");', '', 'ALTER TABLE "A" DROP COLUMN "b";'].join(
      '\n',
    );
    const dropColumn = scan(sql).findings.find((f) => f.rule === 'drop-column');
    expect(dropColumn?.line).toBe(4);
  });
});

describe('rules that must NOT fire — the calibration that keeps this gate usable', () => {
  it('ALTER TYPE … ADD VALUE is safe (the sanctioned enum-extension pattern, 66 uses in history)', () => {
    expect(ruleIds(`ALTER TYPE "ResourceType" ADD VALUE 'AiTaskDefault';`)).toEqual([]);
  });

  it('ALTER INDEX … RENAME is safe (no application code names an index)', () => {
    expect(ruleIds('ALTER INDEX "core"."Old_idx" RENAME TO "New_idx";')).toEqual([]);
  });

  it('additive column adds are safe', () => {
    expect(ruleIds('ALTER TABLE "Consultation" ADD COLUMN "summary" TEXT;')).toEqual([]);
  });

  it('CREATE TABLE is safe', () => {
    expect(ruleIds('CREATE TABLE "New" ("id" TEXT NOT NULL);')).toEqual([]);
  });

  it('a NOT NULL column in a CREATE TABLE is not a SET NOT NULL', () => {
    // The rule targets the ALTER form; a new table cannot break a running image.
    expect(ruleIds('CREATE TABLE "New" ("id" TEXT NOT NULL, "t" TEXT NOT NULL);')).toEqual([]);
  });

  it('a rule keyword inside a comment never fires', () => {
    expect(ruleIds('-- we deliberately do not DROP COLUMN "x" here\nSELECT 1;')).toEqual([]);
    expect(ruleIds('/* DROP TABLE "x" was rejected in review */\nSELECT 1;')).toEqual([]);
  });
});

describe('CREATE INDEX warning', () => {
  it('warns without CONCURRENTLY, and never errors', () => {
    const report = scan('CREATE INDEX "Consultation_tenantId_idx" ON "Consultation"("tenantId");');
    expect(report.findings.map((f) => f.rule)).toEqual(['non-concurrent-index']);
    expect(report.findings.every((f) => f.severity === 'warn')).toBe(true);
  });

  it('stays silent with CONCURRENTLY', () => {
    expect(ruleIds('CREATE INDEX CONCURRENTLY "a_idx" ON "A"("x");')).toEqual([]);
  });

  it('a warning alone never blocks', () => {
    const report = scan('CREATE UNIQUE INDEX "a_idx" ON "A"("x");');
    expect(evaluate([report]).blocking).toEqual([]);
  });
});

describe('review annotation', () => {
  const destructive = 'ALTER TABLE "Consultation" DROP COLUMN "legacyNote";';

  it('blocks an unreviewed destructive migration', () => {
    expect(evaluate([scan(destructive)]).blocking).toHaveLength(1);
  });

  it('passes once a reason is recorded, and keeps the reason', () => {
    const sql = `-- @expand-contract-reviewed: column added and dropped within this release; no deployed image reads it\n${destructive}`;
    const report = scan(sql);
    expect(report.reviewed).toBe(true);
    expect(report.reviewReason).toMatch(/no deployed image reads it/);
    expect(evaluate([report]).blocking).toEqual([]);
  });

  it('requires a reason — the bare marker does not count', () => {
    expect(readReviewAnnotation('-- @expand-contract-reviewed:\nSELECT 1;')).toBeNull();
  });

  it('flags an annotation on a migration that trips nothing, so it can be removed', () => {
    const report = scan('-- @expand-contract-reviewed: leftover from an earlier draft\nSELECT 1;');
    expect(evaluate([report]).staleAnnotations).toHaveLength(1);
  });
});

describe('SQL parsing helpers', () => {
  it('stripComments preserves line count so line numbers stay accurate', () => {
    const sql = 'SELECT 1;\n-- a comment\n/* block\ncomment */\nSELECT 2;';
    expect(stripComments(sql).split('\n')).toHaveLength(sql.split('\n').length);
  });

  it('splitStatements attributes each statement to its own starting line', () => {
    const statements = splitStatements('SELECT 1;\n\nSELECT 2;\nSELECT 3;');
    expect(statements.map((s) => s.line)).toEqual([1, 3, 4]);
  });

  it('handles a multi-line statement', () => {
    const statements = splitStatements('ALTER TABLE "A"\n  RENAME COLUMN "b"\n  TO "c";');
    expect(statements).toHaveLength(1);
    expect(statements[0].line).toBe(1);
  });

  it('detects a rule split across lines within one statement', () => {
    expect(ruleIds('ALTER TABLE "A"\n  RENAME COLUMN "b" TO "c";')).toContain('rename-table-or-column');
  });
});
