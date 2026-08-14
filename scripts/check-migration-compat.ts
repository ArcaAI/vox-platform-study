#!/usr/bin/env tsx
/**
 * Migration backwards-compatibility gate (TASK-693 §4.4).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The Argo `PreSync` `db-migrate` Job runs BEFORE the new pods roll, which
 * means every migration executes while the PREVIOUS release's pods are still
 * serving traffic. A migration that is not backwards-compatible with the
 * previously-deployed image takes the platform down during a rollout that every
 * probe reports as healthy — there is no failing healthcheck to catch it,
 * because the pods are fine and the schema underneath them is not.
 *
 * Pods are the easy half of zero-downtime. This is the half with no owner.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *
 * It does not prove a migration is safe. It flags the five statement shapes
 * that are *usually* unsafe and forces a human to write down why this one
 * isn't. Expand/contract stays a design discipline; this only stops it being
 * an unrecorded one.
 *
 * ── The escape hatch ────────────────────────────────────────────────────────
 *
 * A flagged migration passes once it carries, anywhere in the file:
 *
 *     -- @expand-contract-reviewed: <reason>
 *
 * Deliberately an in-file annotation rather than a PR label. The justification
 * then lives in git next to the SQL forever, and is visible in the diff that
 * introduces it — a label is invisible six months later when someone is
 * reading the migration to understand an incident. This mirrors the existing
 * `@allowedDirectPrisma <reason>` escape hatch on the controller-Prisma lint
 * rule, which is the same shape of problem.
 *
 * ── Rule calibration (measured against all 87 committed migrations) ─────────
 *
 * Two rules that looked obvious in design were wrong at this repo's scale, and
 * are deliberately narrowed. Both narrowings are load-bearing:
 *
 *   * `RENAME` — every RENAME in the existing history is `ALTER INDEX … RENAME`
 *     inside the TASK-648 index-alignment migration. Renaming an INDEX is safe
 *     (no application code names an index). A blanket RENAME rule would have
 *     been 100% false positives, so the rule requires `ALTER TABLE`.
 *
 *   * `ALTER TYPE` — 66 occurrences, essentially all `ALTER TYPE … ADD VALUE`,
 *     which is the enum-extension pattern `03-domain-layer.md` REQUIRES for any
 *     model emitting sys-events. Adding an enum value is additive and safe. The
 *     rule therefore targets `ALTER COLUMN … TYPE` (a column type change) and
 *     must never fire on `ALTER TYPE … ADD VALUE`.
 *
 * With those narrowings, 6 of 87 historical migrations trip the gate — a
 * signal rate that stays worth reading. A rule that flags everything is a rule
 * people rubber-stamp.
 *
 * `CREATE INDEX` without `CONCURRENTLY` is a WARNING, never an error: 342 of
 * 343 existing indexes are non-concurrent, and at current data volume the
 * ShareLock is measured in milliseconds. It is worth surfacing per-PR (one or
 * two lines) and worthless as a gate.
 *
 * Pure scanning is separated from git plumbing so the rules can be unit-tested
 * without a repository — see `scripts/__tests__/check-migration-compat.test.ts`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type Severity = 'error' | 'warn';

export interface Finding {
  severity: Severity;
  /** Stable rule id, safe to grep for in CI logs. */
  rule: string;
  file: string;
  line: number;
  /** Why this shape breaks the previously-deployed image. */
  why: string;
  excerpt: string;
}

export interface FileReport {
  file: string;
  findings: Finding[];
  reviewed: boolean;
  reviewReason: string | null;
}

/**
 * The reason must be on the SAME line as the marker, and must be non-empty.
 *
 * `[ \t]*` rather than `\s*` after the colon is load-bearing: `\s` matches a
 * newline, so `\s*(.+)` on a bare `-- @expand-contract-reviewed:` line silently
 * adopts the NEXT line as its justification. That turns an empty annotation —
 * the exact thing someone types when they want the gate to shut up — into a
 * passing one.
 */
const REVIEW_ANNOTATION = /--[ \t]*@expand-contract-reviewed:[ \t]*(\S.*)$/im;

interface Rule {
  id: string;
  severity: Severity;
  why: string;
  matches: (statement: string) => boolean;
}

const has = (pattern: RegExp) => (statement: string) => pattern.test(statement);

const RULES: Rule[] = [
  {
    id: 'drop-column',
    severity: 'error',
    why: 'the previously-deployed image still SELECTs and INSERTs this column',
    matches: has(/\bDROP\s+COLUMN\b/i),
  },
  {
    id: 'drop-table',
    severity: 'error',
    why: 'the previously-deployed image still queries this table',
    matches: has(/\bDROP\s+TABLE\b/i),
  },
  {
    id: 'rename-table-or-column',
    severity: 'error',
    why: 'a rename is a drop plus an add as far as the running image is concerned',
    // Requires ALTER TABLE. `ALTER INDEX … RENAME` is safe and must not fire —
    // see the calibration note in the header.
    matches: (statement) => /\bALTER\s+TABLE\b/i.test(statement) && /\bRENAME\b/i.test(statement),
  },
  {
    id: 'alter-column-type',
    severity: 'error',
    why: 'the running image writes the old type; a narrowing cast fails mid-rollout',
    // Requires ALTER COLUMN, so `ALTER TYPE … ADD VALUE` (the sanctioned
    // enum-extension pattern) can never match.
    matches: (statement) => /\bALTER\s+COLUMN\b/i.test(statement) && /\bTYPE\b/i.test(statement),
  },
  {
    id: 'set-not-null',
    severity: 'error',
    why: 'the running image inserts rows without this column and will start erroring',
    matches: has(/\bSET\s+NOT\s+NULL\b/i),
  },
  {
    id: 'non-concurrent-index',
    severity: 'warn',
    why: 'CREATE INDEX takes a ShareLock that blocks writes for the duration',
    matches: (statement) =>
      /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i.test(statement) && !/\bCONCURRENTLY\b/i.test(statement),
  },
];

interface Statement {
  text: string;
  line: number;
}

/**
 * Strip SQL comments while preserving every newline, so line numbers reported
 * against the stripped text still point at the right line of the original.
 * Comment-stripping matters: `-- DROP COLUMN foo` in a note about a migration
 * would otherwise fail the gate for the migration that documents itself well.
 */
export function stripComments(sql: string): string {
  const keepNewlines = (match: string) => match.replace(/[^\n]/g, ' ');
  return sql.replace(/\/\*[\s\S]*?\*\//g, keepNewlines).replace(/--[^\n]*/g, keepNewlines);
}

/** Split into `;`-terminated statements, tracking each one's starting line. */
export function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let buffer = '';
  let line = 1;
  let startLine = 1;

  for (const char of sql) {
    if (char === ';') {
      if (buffer.trim()) statements.push({ text: buffer.trim(), line: startLine });
      buffer = '';
      startLine = line;
      continue;
    }
    if (char === '\n') {
      line += 1;
      if (!buffer.trim()) startLine = line;
    }
    buffer += char;
  }

  if (buffer.trim()) statements.push({ text: buffer.trim(), line: startLine });
  return statements;
}

/** Does this migration carry a reviewer's written justification? */
export function readReviewAnnotation(sql: string): string | null {
  return REVIEW_ANNOTATION.exec(sql)?.[1].trim() ?? null;
}

export function scanMigration(file: string, sql: string): FileReport {
  const reviewReason = readReviewAnnotation(sql);
  const findings: Finding[] = [];

  for (const statement of splitStatements(stripComments(sql))) {
    for (const rule of RULES) {
      if (!rule.matches(statement.text)) continue;
      findings.push({
        severity: rule.severity,
        rule: rule.id,
        file,
        line: statement.line,
        why: rule.why,
        excerpt: statement.text.replace(/\s+/g, ' ').slice(0, 120),
      });
    }
  }

  return { file, findings, reviewed: reviewReason !== null, reviewReason };
}

/**
 * A file fails only when it has ERROR findings AND no review annotation.
 * Warnings never fail. An annotation on a file with no error findings is
 * harmless but pointless, and is reported so it can be removed.
 */
export function evaluate(reports: FileReport[]): { blocking: FileReport[]; staleAnnotations: FileReport[] } {
  const errored = (report: FileReport) => report.findings.some((f) => f.severity === 'error');
  return {
    blocking: reports.filter((r) => errored(r) && !r.reviewed),
    staleAnnotations: reports.filter((r) => !errored(r) && r.reviewed),
  };
}

// ── git plumbing + CLI ──────────────────────────────────────────────────────

const MIGRATIONS_GLOB = 'packages/database/src/prisma/db_main/migrations';

/** Advisory warnings are summarised per file and capped, so errors stay readable. */
const WARN_FILE_LIMIT = 10;

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf-8' }).trim();
}

function migrationsChangedSince(base: string): string[] {
  const mergeBase = git(['merge-base', base, 'HEAD']);
  return git(['diff', '--name-only', '--diff-filter=ACMR', mergeBase, 'HEAD', '--', MIGRATIONS_GLOB])
    .split('\n')
    .filter((path) => path.endsWith('.sql'));
}

function allMigrations(): string[] {
  return git(['ls-files', `${MIGRATIONS_GLOB}/**/*.sql`]).split('\n').filter(Boolean);
}

function main(): number {
  const argv = process.argv.slice(2);
  const scanAll = argv.includes('--all');
  const baseIndex = argv.indexOf('--base');
  const base = baseIndex !== -1 ? argv[baseIndex + 1] : process.env.MIGRATION_COMPAT_BASE;

  let files: string[];
  try {
    if (scanAll) {
      files = allMigrations();
    } else if (base) {
      files = migrationsChangedSince(base);
    } else {
      console.error('usage: check-migration-compat [--all | --base <ref>]');
      console.error('   or: MIGRATION_COMPAT_BASE=<ref> check-migration-compat');
      return 2;
    }
  } catch (error) {
    console.error(`git failed — is "${base}" a ref this clone has? (${(error as Error).message})`);
    return 2;
  }

  if (files.length === 0) {
    console.log('migration-compat: no migration files in scope — nothing to check.');
    return 0;
  }

  const reports = files.map((file) => scanMigration(file, readFileSync(file, 'utf-8')));
  const { blocking, staleAnnotations } = evaluate(reports);

  // One line per file, not per finding. Running this over a long-lived release
  // branch emitted several hundred non-concurrent-index warnings, which buried
  // the errors underneath them — and an advisory that hides the blocking output
  // is worse than no advisory at all.
  const warned = reports
    .map((report) => ({ file: report.file, count: report.findings.filter((f) => f.severity === 'warn').length }))
    .filter((entry) => entry.count > 0);

  for (const entry of warned.slice(0, WARN_FILE_LIMIT)) {
    console.log(`  warn  ${entry.file}  ${entry.count} non-concurrent index creation(s)`);
  }
  if (warned.length > WARN_FILE_LIMIT) {
    console.log(`  warn  … and ${warned.length - WARN_FILE_LIMIT} more file(s) with non-concurrent index creation`);
  }

  for (const report of staleAnnotations) {
    console.log(`  note  ${report.file} carries @expand-contract-reviewed but trips no rule — remove it.`);
  }

  if (blocking.length === 0) {
    const reviewed = reports.filter((r) => r.reviewed && r.findings.some((f) => f.severity === 'error'));
    console.log(
      `migration-compat: OK — ${files.length} migration(s) checked` +
        (reviewed.length ? `, ${reviewed.length} passed on a recorded review` : ''),
    );
    return 0;
  }

  console.error('');
  console.error('migration-compat: FAILED — backwards-incompatible migration(s) with no recorded review.');
  console.error('');
  console.error('The db-migrate PreSync Job runs while the PREVIOUS release is still serving.');
  console.error('Each statement below breaks that image, and no healthcheck will catch it.');
  console.error('');

  for (const report of blocking) {
    console.error(`  ${report.file}`);
    for (const finding of report.findings.filter((f) => f.severity === 'error')) {
      console.error(`    line ${finding.line}  [${finding.rule}] ${finding.why}`);
      console.error(`      ${finding.excerpt}`);
    }
    console.error('');
  }

  console.error('Either rewrite as expand/contract (add the new shape, backfill, drop it in a');
  console.error('LATER release once no running image depends on the old one), or — if this is');
  console.error('genuinely safe — record why, in the migration file itself:');
  console.error('');
  console.error('    -- @expand-contract-reviewed: <why the running image survives this>');
  console.error('');

  return 1;
}

// Only run the CLI when executed directly, so the unit tests can import the
// pure functions above without the process exiting under them.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
