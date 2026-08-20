/**
 * TASK-732 Phase 4 Task 14 — every note-generation path produces an assured
 * draft.
 *
 * TASK-714 bought this property TEMPORARILY on the legacy path only ("no
 * code path creates a `RAW_SUMMARY` without a `SummaryMeta`" — its own
 * Acceptance Criteria). TASK-732 deleted that legacy path and its floor.
 * This test is the PERMANENT form of the same property: after this ticket
 * there is the harness path, plus the kept helper/rollup generators
 * (`ComprehensiveSummaryProcessor` + its sync twin `ChainSummaryService`,
 * and sync `SummaryService.generateSummary`) which are ALSO signable — only
 * `PreSummaryProcessor`'s `PRE_SUMMARY` output is structurally non-signable
 * (see `kept-generators-signability.task732.test.ts`) — and EVERY one of
 * them still writes a `SummaryMeta` alongside the `RAW_SUMMARY` `ContextItem` it
 * creates.
 *
 * Static source scan (node:fs, no imports), following the shape of the
 * repo's other source-scanning contract tests
 * (`services-manifest.contract.test.ts`, `npm-publish-policy.contract.test.ts`).
 * File-level co-occurrence, not per-call-site AST analysis: every file that
 * calls `ContextItemFactory.CreateRawSummary(` (which unconditionally sets
 * `type: RAW_SUMMARY`, regardless of caller — verified against
 * `ContextItemFactory.ts`) must also call `SummaryMetaFactory.Create*(` AND
 * a `summaryMetaRepository.create(`/`.updateWithVersion(` write. Coarser
 * than an AST check, but matches this repo's other contract tests in
 * complexity, and every current caller is a small, single-purpose file where
 * file-level co-occurrence IS effectively call-site co-occurrence.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const APPLICATIONS_SRC = resolve(REPO_ROOT, 'packages/applications/src');

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

const RAW_SUMMARY_CALL = /ContextItemFactory\.CreateRawSummary\(/;
const SUMMARY_META_FACTORY_CALL = /SummaryMetaFactory\.Create\w*\(/;
const SUMMARY_META_WRITE = /summaryMetaRepository\.(create|updateWithVersion)\(/;

describe('TASK-732 Phase 4 — note-generation assurance contract', () => {
  it("ContextItemFactory.CreateRawSummary always sets type: RAW_SUMMARY (the premise this contract's file-level check relies on)", () => {
    const factorySource = readFileSync(
      resolve(REPO_ROOT, 'packages/domains/src/factories/generated/core/ContextItemFactory.ts'),
      'utf8',
    );
    const methodMatch = /static CreateRawSummary\([\s\S]*?\n {2}\}/.exec(factorySource);
    expect(methodMatch, 'ContextItemFactory.CreateRawSummary not found — this contract cannot verify its premise').toBeTruthy();
    expect(methodMatch![0]).toMatch(/type:\s*Enums\.ContextItemType\.RAW_SUMMARY/);
  });

  it('every file that creates a RAW_SUMMARY ContextItem also writes a SummaryMeta', () => {
    const files = listTsFiles(APPLICATIONS_SRC);
    expect(files.length, 'sanity: the applications tree must not be empty').toBeGreaterThan(100);

    const rawSummaryProducers = files.filter((f) => RAW_SUMMARY_CALL.test(readFileSync(f, 'utf8')));
    // Sanity floor — the known producers as of this pass (README §2.5/§0.1 and
    // the deletion-manifest's Task 8 record): ContextService (manual save),
    // HarnessInternalService (the harness callback), ComprehensiveSummaryProcessor,
    // ChainSummaryService, SummaryService (sync generateSummary). A count below
    // this means a producer this contract doesn't know about disappeared
    // silently; a count above it is fine (a NEW producer must still pass the
    // assurance check below — that is the point of a contract test).
    expect(rawSummaryProducers.length, `RAW_SUMMARY producers found: ${rawSummaryProducers.map((f) => f.slice(APPLICATIONS_SRC.length))}`).toBeGreaterThanOrEqual(5);

    const violations: string[] = [];
    for (const file of rawSummaryProducers) {
      const source = readFileSync(file, 'utf8');
      const relativePath = file.slice(REPO_ROOT.length + 1);

      if (!SUMMARY_META_FACTORY_CALL.test(source)) {
        violations.push(`${relativePath}: creates a RAW_SUMMARY ContextItem but never calls SummaryMetaFactory.Create*(...)`);
      }
      if (!SUMMARY_META_WRITE.test(source)) {
        violations.push(`${relativePath}: creates a RAW_SUMMARY ContextItem but never persists via summaryMetaRepository.create/updateWithVersion(...)`);
      }
    }

    expect(
      violations,
      `TASK-714 bought "no RAW_SUMMARY without a SummaryMeta" temporarily on the legacy path; TASK-732 made it ` +
        `permanent by deleting every OTHER path. A violation below means a note-generation path can produce an ` +
        `un-assured draft:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('the deleted legacy generator is not among the producers (regression lock for TASK-732)', () => {
    const files = listTsFiles(APPLICATIONS_SRC);
    const rawSummaryProducerNames = files.filter((f) => RAW_SUMMARY_CALL.test(readFileSync(f, 'utf8'))).map((f) => f.split('/').pop());
    expect(rawSummaryProducerNames).not.toContain('summary.processor.ts');
  });
});
