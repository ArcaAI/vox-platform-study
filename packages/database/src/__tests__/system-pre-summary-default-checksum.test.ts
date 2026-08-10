/**
 * TASK-635 B-10 — drift lock for the SYSTEM default pre-summary body.
 *
 * `SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT` (`TEMPLATE_IDS.PRE_SUMMARY_DEFAULT`,
 * id `71000000-0000-0000-0000-000000000040`) is the SYSTEM-tier pre-summary
 * fallback that `PromptResolutionService` serves platform-wide as
 * `SYSTEM_DEFAULTS.preSummaryPromptId` (tier-2, after the tenant-default
 * convention lookup and before the 503 fail-closed). It is seeded under the
 * GLOBAL customer tenant (`DEFAULT_TENANT_ID`), NOT a SYSTEM tenant — see the
 * NOTE above the constant's declaration in `07-prompt-template.ts` and B-10 /
 * OD-4 in
 * docs/implementation/TASK-635-Summarization-Agent-Conformance/README.md.
 *
 * This body is a HAND-MAINTAINED NEAR-DUPLICATE of the v1-parity ArcaAI
 * pre-summary (`PRE_SUMMARY_CONTENT` in `07b-arcaai-clinical-content.ts`,
 * checksum-locked by `v1-clinical-prompt-fidelity.test.ts`) but was, before
 * this test, free to drift silently — no test pinned its content. This test
 * locks it to its CURRENT (as of TASK-635) sha256 so a future edit is a
 * conscious, reviewed change rather than silent drift.
 *
 * Deliberately NOT added to `v1-clinical-prompt-checksums.fixture.ts`: that
 * fixture asserts exactly 15 entries with v1-pod provenance
 * (`v1-clinical-prompt-fidelity.test.ts`), and this constant has neither —
 * it was never extracted from the v1 pod, and it is a distinct seed row from
 * the ArcaAI tenant's pre-summary.
 *
 * A hash mismatch here means `SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT` changed.
 * That is not necessarily wrong — but before updating the pinned hash below,
 * consciously decide whether `PRE_SUMMARY_CONTENT` (07b-arcaai-clinical-content.ts)
 * needs the same change (B-10), since the two currently read as near-duplicates.
 */

import { createHash } from 'crypto';

import { describe, it, expect } from 'vitest';

import { SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT } from '../prisma/db_main/seed/07-prompt-template';

/** Pinned sha256 of `SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT` as of TASK-635. */
const PINNED_SHA256 = 'be6be5760819c34c22029ac1293474b452e0f75a34c885fb9f0eeab3ce05335a';

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

describe('TASK-635 B-10 — SYSTEM default pre-summary content drift lock', () => {
  it('SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT matches its pinned sha256', () => {
    const actualSha256 = sha256Hex(SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT);

    expect(
      actualSha256,
      'SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT (07-prompt-template.ts, TEMPLATE_IDS.PRE_SUMMARY_DEFAULT) has changed.\n' +
        `  expected (pinned) sha256: ${PINNED_SHA256}\n` +
        `  actual sha256:            ${actualSha256}\n` +
        'If this is an intentional, reviewed content change, update PINNED_SHA256 above and ' +
        'consciously decide whether PRE_SUMMARY_CONTENT (07b-arcaai-clinical-content.ts) needs the ' +
        'same change (TASK-635 B-10) — the two bodies are hand-maintained near-duplicates.',
    ).toBe(PINNED_SHA256);
  });
});
