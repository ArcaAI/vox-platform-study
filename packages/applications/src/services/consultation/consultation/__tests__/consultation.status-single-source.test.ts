/**
 * TASK-711 — session state machine, single-source-of-truth gates.
 *
 * `Consultation.status` is now written EXCLUSIVELY through
 * `ConsultationEntity.transitionTo`. This grep-gate (modelled on
 * `note-generation/__tests__/harness-enabled-single-reader.grep-gate.test.ts`
 * and `packages/domains/src/enums/__tests__/resourceType.enum-parity.test.ts`'s
 * node:fs-based scanning) asserts, across ALL of `packages/applications/src`:
 *
 *   1. Zero writes to the legacy `metadata.status` tracker (deleted — Task 10).
 *   2. Zero direct `consultation.status = <value>` assignments bypassing the
 *      legality matrix, except the ONE documented, kill-switch-gated
 *      exception in `ConsultationService.startRecording` (README §4 Task 9
 *      step 4 — the `requirePrimedBeforeRecording` flag's OFF branch, which
 *      deliberately reproduces pre-711 behaviour for legacy callers).
 *
 * DO NOT delete this test as redundant with the domains-layer
 * `consultationStatus.wired.test.ts` — that one proves the matrix is
 * COMPLETE; this one proves the matrix is the ONLY path, which is the
 * property that would have caught `updateConsultation`'s pre-711
 * `nextMeta.status = request.status` forgery vector (TASK-701) before it
 * shipped.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APPLICATIONS_SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The one documented, kill-switch-gated exception (README §4 Task 9 step 4). */
const ALLOWED_DIRECT_ASSIGNMENT = {
  relativePath: 'services/consultation/consultation/consultation.service.ts',
  line: 'consultation.status = ConsultationStatus.RECORDING;',
  markerComment: 'TASK-711 grep-gate NOTE',
};

const METADATA_STATUS_RE = /\bmetadata(?:\?\.|\.)status\b/;
// `consultation.status = <value>` — deliberately narrow to the variable name
// every write site in this codebase uses (verified by repo-wide grep before
// this test was authored), so it doesn't false-positive on unrelated
// `.status =` assignments on other entities (TranscriptionJob, WebhookRun, …).
const DIRECT_STATUS_ASSIGNMENT_RE = /\bconsultation\.status\s*=\s*[^=]/;

function listTsFiles(dir: string, exclude: Set<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (exclude.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full, exclude));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('Consultation.status single-source-of-truth gate (TASK-711)', () => {
  const files = listTsFiles(APPLICATIONS_SRC_ROOT, new Set(['__tests__', 'node_modules', 'dist']));

  it('sanity: the applications src tree is not empty', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('finds zero writes to the legacy metadata.status tracker', () => {
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const relativePath = file.slice(APPLICATIONS_SRC_ROOT.length + 1);
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((lineText, idx) => {
        const trimmed = lineText.trim();
        // Skip prose comment lines (this ticket's own removal is documented
        // in-code with the literal string `metadata.status` — that is
        // DOCUMENTATION of the deletion, not a violation of it).
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/**')) return;
        if (METADATA_STATUS_RE.test(lineText)) {
          violations.push({ file: relativePath, line: idx + 1, text: trimmed });
        }
      });
    }

    expect(
      violations,
      `metadata.status is deleted (TASK-711 Task 10) — every hit below must be removed, ` +
        `or this test's regex updated if it is a false positive (e.g. an unrelated entity's ` +
        `own 'metadata.status' shape):\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });

  it('finds zero direct `consultation.status = …` assignments outside the one documented allow-list', () => {
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const relativePath = file.slice(APPLICATIONS_SRC_ROOT.length + 1);
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((lineText, idx) => {
        if (!DIRECT_STATUS_ASSIGNMENT_RE.test(lineText)) return;

        const isAllowed = relativePath === ALLOWED_DIRECT_ASSIGNMENT.relativePath && lineText.trim() === ALLOWED_DIRECT_ASSIGNMENT.line;
        if (isAllowed) return;

        violations.push({ file: relativePath, line: idx + 1, text: lineText.trim() });
      });
    }

    expect(
      violations,
      `Every consultation status write must route through ConsultationEntity.transitionTo. ` +
        `The only allowed direct assignment is the documented kill-switch bypass in ` +
        `${ALLOWED_DIRECT_ASSIGNMENT.relativePath}. Violations:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });

  it('the one allow-listed exception still exists, at the expected site, with its documented-exception marker', () => {
    const source = readFileSync(resolve(APPLICATIONS_SRC_ROOT, ALLOWED_DIRECT_ASSIGNMENT.relativePath), 'utf8');
    expect(source, 'the allow-listed direct assignment must still be present — if removed, delete this allow-list entry too').toContain(
      ALLOWED_DIRECT_ASSIGNMENT.line,
    );
    expect(source, 'the allow-listed assignment must carry its documented-exception marker comment').toContain(ALLOWED_DIRECT_ASSIGNMENT.markerComment);
  });
});
