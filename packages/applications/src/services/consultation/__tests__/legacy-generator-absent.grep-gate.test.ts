/**
 * TASK-732 Phase 4 Task 13 — Grep-gate: no legacy generator remains.
 *
 * The permanence mechanism for this ticket's deletion. Follows TASK-704 Task
 * 6's pattern exactly (`settings-registry/__tests__/consultation-gate-seed-parity.test.ts`
 * and `note-generation/__tests__/harness-enabled-single-reader.grep-gate.test.ts`):
 * reads source with `node:fs`, never imports, so a reintroduction is caught
 * even if it would otherwise compile.
 *
 * Scope: `packages/applications/src` and `apps/api/src`, excluding
 * `__tests__/**` directories (tests are expected to mention the deleted
 * names — coverage ledgers, historical fixtures — and are not the
 * permanence surface this gate protects).
 *
 * Comments are stripped before matching (both `//` and `/* *‍/` forms). A
 * comment that explains WHAT was deleted and WHY (several were added by this
 * ticket itself, e.g. "`createSummaryJob`/`createNerJob` were deleted here")
 * is legitimate, valuable documentation — this gate cares about LIVE CODE
 * that would reintroduce the deleted path, not prose that mentions its name.
 * Every assertion below therefore scans comment-stripped source.
 *
 * Assertions (README §4 Task 13):
 *   1. zero files named `summary.processor.ts` / `ner.processor.ts` under
 *      `consultation/jobs/processors/`
 *   2. zero CODE occurrences of `SummaryProcessor`, `NerProcessor`,
 *      `createSummaryJob`, `createNerJob`
 *   3. zero CODE occurrences of `JobQueue.GenerateSummary` / `JobQueue.ExtractNamedEntities`
 *   4. the seam (`note-generation.service.ts`) has no `createSummaryJob`-shaped
 *      dispatch — restated here even though #2 already covers it, because the
 *      ticket names it as its own acceptance line
 *   5. zero CODE references to TASK-714's floor utility (`legacy-dosage-check`,
 *      `checkDosageParity`, `applyLegacySafetyFloor`)
 *
 * Every assertion message names this ticket, so a future reintroduction
 * fails with an explanation rather than a bare diff.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APPLICATIONS_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const API_SRC = resolve(APPLICATIONS_SRC, '..', '..', '..', 'apps', 'api', 'src');
const PROCESSORS_DIR = resolve(APPLICATIONS_SRC, 'services', 'consultation', 'jobs', 'processors');

/** List every `.ts` file under `dir`, excluding any `__tests__` directory. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strip `//` and `/* *‍/` comments so matches only fire on live code, not
 * on prose that legitimately explains what was deleted and why. A
 * deliberately simple regex pass (no string-literal awareness) — consistent
 * with this repo's other source-scanning gates, and safe here because none
 * of the identifiers this gate looks for ever legitimately appears inside a
 * string literal in production code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function collectMatches(files: string[], pattern: RegExp): Array<{ file: string; line: number; text: string }> {
  const violations: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const stripped = stripComments(raw);
    const strippedLines = stripped.split('\n');
    strippedLines.forEach((lineText, idx) => {
      pattern.lastIndex = 0;
      if (pattern.test(lineText)) {
        violations.push({ file, line: idx + 1, text: lineText.trim() });
      }
    });
  }
  return violations;
}

describe('TASK-732 — legacy signable generator is absent (grep-gate)', () => {
  const applicationsFiles = listTsFiles(APPLICATIONS_SRC);
  const apiFiles = listTsFiles(API_SRC);
  const allFiles = [...applicationsFiles, ...apiFiles];

  it('sanity: the scanned trees are not empty', () => {
    expect(applicationsFiles.length).toBeGreaterThan(100);
    expect(apiFiles.length).toBeGreaterThan(50);
  });

  it('1. summary.processor.ts and ner.processor.ts no longer exist under consultation/jobs/processors/', () => {
    const entries = readdirSync(PROCESSORS_DIR).filter((e) => statSync(join(PROCESSORS_DIR, e)).isFile());
    expect(entries, 'TASK-732 deleted these two files — a reintroduction under this exact name is the regression this row catches').not.toContain(
      'summary.processor.ts',
    );
    expect(entries).not.toContain('ner.processor.ts');
  });

  it('2. zero live-code occurrences of SummaryProcessor / NerProcessor / createSummaryJob / createNerJob', () => {
    const violations = collectMatches(allFiles, /\b(SummaryProcessor|NerProcessor|createSummaryJob|createNerJob)\b/);
    expect(
      violations,
      `TASK-732 deleted the legacy signable generator (summary.processor.ts/ner.processor.ts) and its ` +
        `ConsultationJobService methods. A live-code reference below means the deletion was (partially) reverted:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });

  it('3. zero live-code occurrences of JobQueue.GenerateSummary / JobQueue.ExtractNamedEntities', () => {
    const violations = collectMatches(allFiles, /JobQueue\.(GenerateSummary|ExtractNamedEntities)\b/);
    expect(
      violations,
      `TASK-732 removed every runtime reader of these two BullMQ queues ahead of the enum-member deletion ` +
        `(the enum members themselves stay, pending the R-5 drain confirmation — see deletion-manifest.md §2). ` +
        `A live-code reference below means a new reader was reintroduced:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });

  it('4. the seam (note-generation.service.ts) has no createSummaryJob-shaped legacy dispatch', () => {
    const seamPath = resolve(APPLICATIONS_SRC, 'services', 'consultation', 'note-generation', 'note-generation.service.ts');
    const stripped = stripComments(readFileSync(seamPath, 'utf8'));
    expect(stripped, 'the seam must never itself dispatch to the legacy generator — it only returns a decision').not.toMatch(
      /createSummaryJob|createNerJob/,
    );
  });

  it('5. zero live-code references to TASK-714 floor utility (legacy-dosage-check / checkDosageParity / applyLegacySafetyFloor)', () => {
    const violations = collectMatches(allFiles, /legacy-dosage-check|checkDosageParity|applyLegacySafetyFloor/);
    expect(
      violations,
      `TASK-714's legacy safety floor was throwaway by its own ticket's design, deleted by TASK-732 in the ` +
        `same epic that retires legacy. A live-code reference below means it (or a shared abstraction it grew) ` +
        `survived:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });
});
