/**
 * -T1 (database half) — byte lock for the SYSTEM live-summarization
 * default prompt.
 *
 * PAIRED with
 * `packages/applications/src/services/consultation/live-documentation/__tests__/live-soap-prompt-checksum.test.ts`,
 * which pins the SAME two hashes against the in-code constants
 * (`LIVE_SOAP_STABLE_SYSTEM_PREFIX` and the `system_prompt` literal in
 * `callText`). Together the two tests are a byte-equality proof across the
 * package boundary without a cross-package import — `packages/database` cannot
 * depend on `packages/applications` (wrong dependency direction), and the seed
 * modules are not part of this package's public exports.
 *
 * WHY THIS MUST HOLD. Lane C3's live chain is agent binding → this SYSTEM
 * default → the in-code constants, where tier 3 is a deliberate FAIL-OPEN (a
 * running consultation must never die on a prompt-resolution error). That
 * exception is only safe while tiers 2 and 3 serve IDENTICAL bytes; the moment
 * they diverge, "fail-open" silently becomes "different prompt".
 *
 * A mismatch here means the SEED constants changed. Before updating a pinned
 * hash below, change the in-code constant to match in the SAME commit and
 * update the applications-side test's identical pin — otherwise the live loop
 * and its governed template have drifted apart.
 */

import { createHash } from 'crypto';

import { describe, it, expect } from 'vitest';

import { SYSTEM_LIVE_SOAP_TEMPLATE_ID, SYSTEM_LIVE_SOAP_VERSION_ID, SYSTEM_TENANT_ID } from '../prisma/db_main/seed/00-constants';
import {
  SYSTEM_LIVE_SOAP_PROMPT_CONTENT,
  SYSTEM_LIVE_SOAP_SYSTEM_PROMPT,
  SYSTEM_LIVE_SOAP_TEMPLATE,
  SYSTEM_LIVE_SOAP_VERSION,
} from '../prisma/db_main/seed/07c-live-agent-defaults';

/**
 * Pinned sha256 of the live-loop prompt constants.
 * THE SAME TWO LITERALS appear in the applications-side test — change both or
 * neither.
 *
 * RE-PINNED BY TASK-810, deliberately (ticket §4 Task 13). BOTH digests moved
 * because both prompts moved, and the guard doing its job is exactly why the
 * change had to be made consciously rather than noticed later:
 *
 *  - `SYSTEM_LIVE_SOAP_PROMPT_CONTENT` no longer spells out four SOAP headings.
 *    The live loop COMPILES its instruction from the document-shape catalog, so
 *    the prose instruction and the strict `json_schema` provably describe the
 *    same document. Those four literals were one of the five places that made
 *    a tenant-authored shape structurally impossible.
 *  - Both prompts stop asserting that the note IS a SOAP note (DD-1: SOAP is a
 *    row in the catalog, not a privileged type), and the instruction now names
 *    `null` as the "not discussed" sentinel instead of telling the model to
 *    "leave a section blank" while a `strict`, all-`required` schema forbade it
 *    from doing so (D-21).
 *
 * Previous digests, for the record:
 *   prompt  efec476696dea4490e9041b3560458746b745c0f9c03b17db568811c2ae7132f
 *   system  25769ec9be08696e4e9fb8576de59e9b12fbef58f0159277eb08f3a2cf921cf3
 */
const PINNED_PROMPT_SHA256 = '8a0703713748220d7e005d9ca52f71957c57df04acdbb0e6333ad3b391382d32';
const PINNED_SYSTEM_PROMPT_SHA256 = 'd3ce3a7c63fd5d4e6aecc32921759759ab79c8800194a7d6c42ecc2d81a3174c';

const sha256Hex = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

describe('-T1 — SYSTEM live-summarization default prompt byte lock', () => {
  it('SYSTEM_LIVE_SOAP_PROMPT_CONTENT matches the pinned sha256 of LIVE_SOAP_STABLE_SYSTEM_PREFIX', () => {
    expect(
      sha256Hex(SYSTEM_LIVE_SOAP_PROMPT_CONTENT),
      'The seeded SYSTEM live prompt no longer matches the in-code LIVE_SOAP_STABLE_SYSTEM_PREFIX. ' +
        'The live chain’s code-default fail-open tier is only safe while tiers 2 and 3 are byte-identical.',
    ).toBe(PINNED_PROMPT_SHA256);
  });

  it('SYSTEM_LIVE_SOAP_SYSTEM_PROMPT matches the pinned sha256 of the callText system_prompt literal', () => {
    expect(sha256Hex(SYSTEM_LIVE_SOAP_SYSTEM_PROMPT)).toBe(PINNED_SYSTEM_PROMPT_SHA256);
  });

  it('seeds the template content and its v1 version snapshot from the SAME constant', () => {
    // The template row and the immutable PromptVersion snapshot must never be
    // allowed to disagree — the resolver serves the VERSION, the admin console
    // renders the TEMPLATE.
    expect(SYSTEM_LIVE_SOAP_TEMPLATE.content).toBe(SYSTEM_LIVE_SOAP_PROMPT_CONTENT);
    expect(SYSTEM_LIVE_SOAP_VERSION.content).toBe(SYSTEM_LIVE_SOAP_PROMPT_CONTENT);
    expect(SYSTEM_LIVE_SOAP_VERSION.versionNumber).toBe(SYSTEM_LIVE_SOAP_TEMPLATE.approvedVersionNumber);
  });

  it('is SYSTEM-owned, APPROVED and version-pinned so every tenant can resolve it', () => {
    // SYSTEM ownership + the B-12 read-widening is what makes this row visible
    // from a customer tenant's CLS at all; APPROVED is the resolver's governance
    // gate; approvedVersionNumber pins the immutable snapshot (F-02).
    expect(SYSTEM_LIVE_SOAP_TEMPLATE.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(SYSTEM_LIVE_SOAP_TEMPLATE.status).toBe('APPROVED');
    expect(SYSTEM_LIVE_SOAP_TEMPLATE.approvedVersionNumber).toBe(1);
    expect(SYSTEM_LIVE_SOAP_TEMPLATE.departmentId).toBeNull();
    expect(SYSTEM_LIVE_SOAP_TEMPLATE.id).toBe(SYSTEM_LIVE_SOAP_TEMPLATE_ID);
    expect(SYSTEM_LIVE_SOAP_VERSION.id).toBe(SYSTEM_LIVE_SOAP_VERSION_ID);
  });

  it('carries the system-role string under metaData.promptConfig.systemPrompt', () => {
    // The convention PromptAssemblyService already uses for
    // promptConfig.hyperparameters / promptConfig.outputSchema — no schema
    // change, no new PromptTemplateCategory member.
    const metaData = SYSTEM_LIVE_SOAP_TEMPLATE.metaData as { promptConfig?: { systemPrompt?: string } };
    expect(metaData.promptConfig?.systemPrompt).toBe(SYSTEM_LIVE_SOAP_SYSTEM_PROMPT);
  });
});
