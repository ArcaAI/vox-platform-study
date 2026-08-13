/**
 * Drift lock for the department-free pre-summary FORK.
 *
 * `SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT`
 * (`07d-dept-free-pre-summary-default.ts`, id `71000000-0000-0000-0004-000000000002`,
 * `SYSTEM_DEFAULTS.deptFreePreSummaryPromptId`) is the native-only fork of the
 * v1-parity pre-summary body (`SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT`,
 * `07-prompt-template.ts`, itself locked by
 * `system-pre-summary-default-checksum.test.ts`) with every
 * department/visit-type indicator removed — see the derivation notes at the
 * top of `07d-dept-free-pre-summary-default.ts`.
 *
 * This is a SEPARATE lock from the 15-entry v1-pod fidelity fixture
 * (`v1-clinical-prompt-checksums.fixture.ts`) — this content has no v1-pod
 * provenance, it is a hand-derived fork, and D2 is explicitly instructed not
 * to add it there.
 *
 * A hash mismatch means `SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT` changed. That
 * may be an intentional edit — update `PINNED_SHA256` below after review — but
 * it must never be a SILENT drift, and it must never re-introduce
 * `{current_department}` / `{visit_type}` / "(Latest Dept Note)" (the RF-1
 * wire-contract split exists precisely to keep those OUT of this body while
 * keeping them IN the v1-compat body).
 */

import { createHash } from 'crypto';

import { describe, it, expect } from 'vitest';

import { SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT } from '../prisma/db_main/seed/07d-dept-free-pre-summary-default';

/** Pinned sha256 of `SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT` as of.*/
const PINNED_SHA256 = '0751eb9a4221e6f58ea9892a9dcf42116965d48ea4cb6d6ad0e3f76a4bdb3e39';

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

describe('department-free pre-summary fork content drift lock', () => {
  it('SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT matches its pinned sha256', () => {
    const actualSha256 = sha256Hex(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT);

    expect(
      actualSha256,
      'SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT (07d-dept-free-pre-summary-default.ts) has changed.\n' +
        `  expected (pinned) sha256: ${PINNED_SHA256}\n` +
        `  actual sha256:            ${actualSha256}\n` +
        'If this is an intentional, reviewed content change, update PINNED_SHA256 above.',
    ).toBe(PINNED_SHA256);
  });

  it('carries none of v1\'s department/visit-type indicators (RF-1 — the whole point of the fork)', () => {
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT).not.toContain('{current_department}');
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT).not.toContain('{visit_type}');
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT).not.toContain('Department:');
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT).not.toContain('Visit Type:');
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT).not.toContain('(Latest Dept Note)');
  });

  it('keeps the remaining seven v1 variables intact', () => {
    for (const name of [
      'safe_age',
      'safe_dob',
      'safe_gender',
      'safe_vitals',
      'formatted_test_results',
      'formatted_previous_visits',
      'language_name',
    ]) {
      expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT).toContain(`{${name}}`);
    }
  });
});
