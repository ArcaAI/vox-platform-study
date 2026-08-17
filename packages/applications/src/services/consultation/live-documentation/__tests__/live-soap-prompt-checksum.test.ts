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

import { LIVE_SOAP_STABLE_SYSTEM_PREFIX, LIVE_SOAP_SYSTEM_PROMPT } from '../live-documentation.service';

/** Identical literals to the database-side test — change both or neither. */
const PINNED_PROMPT_SHA256 = 'efec476696dea4490e9041b3560458746b745c0f9c03b17db568811c2ae7132f';
const PINNED_SYSTEM_PROMPT_SHA256 = '25769ec9be08696e4e9fb8576de59e9b12fbef58f0159277eb08f3a2cf921cf3';

const sha256Hex = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

/**
 * C2 wrote this guard against the SOURCE TEXT of `live-documentation.service.ts`,
 * because the `system_prompt` was then an inline literal in `callText` and C2 did
 * not own that file. Its own failure message named the successor: *"If C3 has
 * lifted it onto FrozenLiveAgentSnapshot, replace this extraction with a direct
 * import of the exported constant."*
 *
 * C3 has now done exactly that — `LIVE_SOAP_SYSTEM_PROMPT` is the tier-3
 * fail-open source a session freezes — so the brittle regex extraction is
 * replaced by a direct import. **The pinned hashes below are UNCHANGED**: the
 * lift moved zero bytes (it only split one literal across a `+`, as the seed
 * constant already did), which is precisely what the still-green pins prove.
 */

describe('Live-summarization prompt constants byte lock', () => {
  it('LIVE_SOAP_STABLE_SYSTEM_PREFIX matches the pinned sha256 (= the seeded SYSTEM live template content)', () => {
    expect(
      sha256Hex(LIVE_SOAP_STABLE_SYSTEM_PREFIX),
      'LIVE_SOAP_STABLE_SYSTEM_PREFIX changed. The seeded SYSTEM live-default template ' +
        '(packages/database/.../seed/07c-live-agent-defaults.ts) must change identically in the same commit, ' +
        'or the live chain’s code-default fail-open tier stops being behaviour-identical to the governed tier.',
    ).toBe(PINNED_PROMPT_SHA256);
  });

  it('LIVE_SOAP_SYSTEM_PROMPT matches the pinned sha256 (= the seeded metaData.promptConfig.systemPrompt)', () => {
    expect(
      sha256Hex(LIVE_SOAP_SYSTEM_PROMPT),
      'LIVE_SOAP_SYSTEM_PROMPT changed. The seeded SYSTEM live-default template’s ' +
        'metaData.promptConfig.systemPrompt must change identically in the same commit.',
    ).toBe(PINNED_SYSTEM_PROMPT_SHA256);
  });
});
