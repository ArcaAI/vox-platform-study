/**
 * (applications half) — byte lock for the live-summarization
 * prompt constants.
 *
 * PAIRED with `packages/database/src/__tests__/system-live-soap-default-checksum.test.ts`,
 * which pins THE SAME TWO HASHES against the seeded SYSTEM-tenant template
 * (`seed/07c-live-agent-defaults.ts`, id `71000000-0000-0000-0004-000000000001`).
 * Together they prove byte equality across the package boundary. A direct
 * import is not possible in either direction: `packages/database` may not depend
 * on `packages/applications`, and the seed modules are not exported from the
 * database package. This is the same paired-guard shape
 * `07b-arcaai-clinical-templates.ts` uses for `PRE_SUMMARY_VARIABLES`.
 *
 * WHY IT MATTERS. Lane C3 resolves the live prompt through
 * agent binding → the SYSTEM default template → these in-code constants, where
 * the last tier is a documented FAIL-OPEN: a live consultation must never be
 * failed by a prompt-resolution error. That exception is only safe while the
 * last two tiers are byte-identical — otherwise "fail-open" silently becomes
 * "a different prompt".
 *
 * If a hash below changes, update the seed constants in
 * `07c-live-agent-defaults.ts` and the database-side pin IN THE SAME COMMIT.
 */

import { createHash } from 'crypto';

import { describe, it, expect } from 'vitest';

import { LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX, LIVE_DOCUMENT_SYSTEM_PROMPT } from '../live-documentation.service';

/** Identical literals to the database-side test — change both or neither. */
const PINNED_PROMPT_SHA256 = '8a0703713748220d7e005d9ca52f71957c57df04acdbb0e6333ad3b391382d32';
const PINNED_SYSTEM_PROMPT_SHA256 = 'd3ce3a7c63fd5d4e6aecc32921759759ab79c8800194a7d6c42ecc2d81a3174c';

const sha256Hex = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

/**
 * RE-PINNED BY , and both digests moved.
 *
 * This guard failing was the guard WORKING: the whole reason it exists is that
 * a change to these bytes must be a conscious act, and changed them
 * on purpose.
 *
 *  - The stable prefix no longer spells out four SOAP headings. It is COMPILED
 *    from the document-shape catalog (`SOAP_NOTE_SHAPE` ->
 *    `compileDocumentTemplate`), so the prose instruction a prose-only provider
 *    reads and the strict `json_schema` a structured provider is decoded
 *    against are generated from one shape and cannot drift apart. The literal
 *    it replaced was one of the five places that made a tenant-authored
 *    document shape structurally impossible.
 *  - Both constants stop asserting the note IS a SOAP note (DD-1: SOAP is a row
 *    in the catalog, not a privileged type), and the instruction now names
 *    `null` as the "not discussed" sentinel rather than telling the model to
 *    "leave a section blank" while a `strict`, all-`required` schema forbade it
 *    from representing absence at all (D-21).
 *
 * The constants were also RENAMED (`LIVE_SOAP_*` -> `LIVE_DOCUMENT_*`) for the
 * same reason: they are no longer about SOAP.
 *
 * Previous digests, for the record:
 *   prompt efec476696dea4490e9041b3560458746b745c0f9c03b17db568811c2ae7132f
 *   system 25769ec9be08696e4e9fb8576de59e9b12fbef58f0159277eb08f3a2cf921cf3
 */

describe('Live-summarization prompt constants byte lock', () => {
  it('LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX matches the pinned sha256 (= the seeded SYSTEM live template content)', () => {
    expect(
      sha256Hex(LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX),
      'LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX changed. The seeded SYSTEM live-default template ' +
        '(packages/database/.../seed/07c-live-agent-defaults.ts) must change identically in the same commit, ' +
        'or the live chain’s code-default fail-open tier stops being behaviour-identical to the governed tier.',
    ).toBe(PINNED_PROMPT_SHA256);
  });

  it('LIVE_DOCUMENT_SYSTEM_PROMPT matches the pinned sha256 (= the seeded metaData.promptConfig.systemPrompt)', () => {
    expect(
      sha256Hex(LIVE_DOCUMENT_SYSTEM_PROMPT),
      'LIVE_DOCUMENT_SYSTEM_PROMPT changed. The seeded SYSTEM live-default template’s ' +
        'metaData.promptConfig.systemPrompt must change identically in the same commit.',
    ).toBe(PINNED_SYSTEM_PROMPT_SHA256);
  });
});
