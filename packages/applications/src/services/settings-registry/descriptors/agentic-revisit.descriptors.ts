// Agentic re-visit carry-forward descriptor (TASK-553 F-18).
//
// `agentic.revisit.carryForwardEnabled` governs whether a consultation that has a
// `parentConsultationId` (a re-visit) carries its PRIOR VISIT's most authoritative
// summary into the generation prompt as a labeled, non-authoritative prior.
//
// It is **DEFAULT OFF** deliberately, and that is a clinical-safety decision, not
// caution about the plumbing: carry-forward inherits the copy-paste / cloned-note
// risk profile (stale or unverified content propagating into a new encounter —
// SOTA §4.5), so it must be an explicit operator opt-in per deployment rather
// than something that switches on with a deploy. With the knob off the assembled
// prompt is byte-identical to the pre-feature prompt.
//
// GLOBAL-ADMIN-ONLY (the `agentic.*` privilege boundary — a privilege rule → 403,
// enforced at the service/route layer, not a cross-tenant probe), tier
// `global-kv`, resolved through `EffectiveSettingsService.resolveEffective` so a
// write via `PUT /admin/settings/registry/:key` governs the running loop with no
// redeploy.

import { SettingDescriptor } from '../registry.types';

export const AGENTIC_REVISIT_CARRY_FORWARD_KEY = 'agentic.revisit.carryForwardEnabled';

/** Code default — OFF (zero behaviour change until an admin opts in). */
export const AGENTIC_REVISIT_CARRY_FORWARD_DEFAULT = false;

/**
 * Hard cap on the carried prior-visit summary. A whole prior note is real prompt
 * budget, and an unbounded carry is how a re-visit prompt grows without limit
 * across a long care episode.
 */
export const PRIOR_VISIT_SUMMARY_MAX_CHARS = 15_000;

/** Appended when the prior-visit summary is cut at the cap. */
export const PRIOR_VISIT_SUMMARY_TRUNCATION_MARKER = '…[prior visit summary truncated]';

/**
 * Bound a carried prior-visit summary, marking the cut so neither the model nor a
 * reviewer can mistake a truncated note for a complete one.
 *
 * Applied at BOTH ends on purpose: the producer
 * (`HarnessInternalService.assemble`) caps what it carries, and prompt assembly
 * caps again immediately before the text reaches the prompt. Assembly is the
 * shared entry point for every caller, so the second application is what makes
 * the bound a property of the PROMPT rather than of one producer.
 */
export function truncatePriorVisitSummary(text: string): string {
  if (text.length <= PRIOR_VISIT_SUMMARY_MAX_CHARS) return text;
  return `${text.slice(0, PRIOR_VISIT_SUMMARY_MAX_CHARS)}${PRIOR_VISIT_SUMMARY_TRUNCATION_MARKER}`;
}

export const AGENTIC_REVISIT_SETTINGS: SettingDescriptor[] = [
  {
    key: AGENTIC_REVISIT_CARRY_FORWARD_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    // agentic.* is GLOBAL-ADMIN-only — platform-owned, not tenant-set.
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    // Feature flag — unset degrades to the code default (OFF), the safe end.
    failMode: 'open-to-default',
    category: 'Agentic Revisit',
    label: 'Re-visit carry-forward',
    description:
      "When ON, a re-visit consultation carries its parent visit's most authoritative summary into the prompt as a labeled, " +
      'non-authoritative prior that must be re-confirmed against the current transcript. Default OFF.',
    default: AGENTIC_REVISIT_CARRY_FORWARD_DEFAULT,
  },
];
