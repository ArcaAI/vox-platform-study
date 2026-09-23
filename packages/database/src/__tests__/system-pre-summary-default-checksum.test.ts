/**
 * Drift lock for the SYSTEM default pre-summary body.
 *
 * `SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT` (`TEMPLATE_IDS.PRE_SUMMARY_DEFAULT`,
 * id `71000000-0000-0000-0000-000000000040`) is the SYSTEM-tier pre-summary
 * fallback that `PromptResolutionService` serves platform-wide as
 * `SYSTEM_DEFAULTS.preSummaryPromptId` (tier-2, after the tenant-default
 * convention lookup and before the 503 fail-closed). It is seeded under the
 * GLOBAL customer tenant (`DEFAULT_TENANT_ID`), NOT a SYSTEM tenant — see the
 * NOTE above the constant's declaration in `07-prompt-template.ts` and B-10 /
 * OD-4 in
 *
 * This body is a HAND-MAINTAINED NEAR-DUPLICATE of the v1-parity ArcaAI
 * pre-summary (`PRE_SUMMARY_CONTENT` in `07b-arcaai-clinical-content.ts`,
 * checksum-locked by `v1-clinical-prompt-fidelity.test.ts`) but was, before
 * this test, free to drift silently — no test pinned its content. This test
 * locks it to its CURRENT (as of) sha256 so a future edit is a
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

/**
 * Pinned sha256 of `SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT`.
 *
 * Updated 2026-09-06 (TASK-890 §3.2/§3.11): the nine v1 single-brace
 * placeholders (`{current_department}`, …) were converted to the ONE
 * `{{context.*}}` grammar — a deliberate, reviewed content change, not drift.
 * `PRE_SUMMARY_CONTENT` (`07b-arcaai-clinical-content.ts`) was CONSCIOUSLY
 * left untouched per B-10: it is a v1 HISTORICAL snapshot (already-served
 * bytes), not a live default, and TASK-890's seed-conversion census scopes
 * conversion to the SYSTEM default + the v3 corpus only.
 *
 * Updated 2026-09-23 (TASK-1001, owner directive: "all pre-summary and summary
 * must be in english, therefore, prompt instructions and configuration must be
 * set to english"): the `{{context.language_name}}` localization block was
 * replaced by the ArcaAI v3 pre-summary's English-only block; the placeholder is
 * retained, neutralised. Previous pin:
 * d394eeb740f4fa4c3bed6205740a53ff231e49bc44b748caf6430729d22db242.
 * `PRE_SUMMARY_CONTENT` was again CONSCIOUSLY left untouched (B-10, v1 history).
 */
const PINNED_SHA256 = '1c8f688676eba7f9e1bddfe31cb2aad8f13a5098912af6e104847fd921e448c5';

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

describe('SYSTEM default pre-summary content drift lock', () => {
  it('SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT matches its pinned sha256', () => {
    const actualSha256 = sha256Hex(SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT);

    expect(
      actualSha256,
      'SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT (07-prompt-template.ts, TEMPLATE_IDS.PRE_SUMMARY_DEFAULT) has changed.\n' +
        `  expected (pinned) sha256: ${PINNED_SHA256}\n` +
        `  actual sha256:            ${actualSha256}\n` +
        'If this is an intentional, reviewed content change, update PINNED_SHA256 above and ' +
        'consciously decide whether PRE_SUMMARY_CONTENT (07b-arcaai-clinical-content.ts) needs the ' +
        'same change (B-10) — the two bodies are hand-maintained near-duplicates.',
    ).toBe(PINNED_SHA256);
  });

  // TASK-1001 (owner directive 2026-09-23) — the instruction itself says English.
  it('instructs English only, and no longer localizes into {{context.language_name}}', () => {
    expect(SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT).toContain('- Language: English (see INSTRUCTIONS).');
    expect(SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT).toContain('**Write the entire pre-summary in English.**');
    // the placeholder is retained (nine-variable contract), neutralised in the text
    expect(SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT).toContain('`{{context.language_name}}` is supplied by the caller and resolves to English');
    expect(SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT).not.toContain('in {{context.language_name}}');
    expect(SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT).not.toContain('into {{context.language_name}}');
    expect(SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT).not.toContain('Parentheses Localization Policy');
    expect(SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT).not.toContain('English words');
  });
});
