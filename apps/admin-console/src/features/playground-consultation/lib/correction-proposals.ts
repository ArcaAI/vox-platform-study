/**
 * TASK-797 W2 — verifying and applying correction proposals safely.
 *
 * A correction is a PROPOSAL. Nothing here applies anything on its own; `applyProposal` is
 * called only from an explicit clinician action, and it returns new text rather than mutating
 * anything.
 *
 * The hazard this module exists for is offset drift. Accepting one proposal shifts every
 * later proposal's offsets whenever the replacement differs in length from the original.
 * Applying a second proposal on its stale offsets would splice over the wrong characters —
 * on a drug name or a dose, that is a patient-safety defect, not a rendering bug. So after
 * each accept every remaining proposal is RE-VERIFIED against the new text, and any that no
 * longer matches is DROPPED. Nothing is silently re-anchored or adjusted.
 *
 * Pure and framework-free so that property is testable without a component.
 */

import type { CorrectionProposal } from '../api/live-assist';

/** True when `proposal` still describes a real, non-empty, non-no-op edit to `text`. */
function verifies(text: string, proposal: CorrectionProposal): boolean {
  const { start, end, original, proposed } = proposal;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || end > text.length || end <= start) return false;
  if (text.slice(start, end) !== original) return false;
  // A replacement identical to the original is not a correction.
  if (proposed === original) return false;
  // Only an open proposal is offerable; an accepted or rejected one is a past decision.
  return proposal.status === 'PROPOSED';
}

/**
 * The proposals that are safe to OFFER against `text`, in document order. Anything whose
 * offsets no longer slice out its own `original` is dropped — never re-anchored by searching
 * for the text, because the second occurrence of a token is not the one the model meant.
 */
export function verifiedProposals(text: string, proposals: readonly CorrectionProposal[]): CorrectionProposal[] {
  return proposals.filter((proposal) => verifies(text, proposal)).sort((left, right) => left.start - right.start);
}

export interface AppliedProposalResult {
  /** The corrected text. */
  text: string;
  /** The proposals that STILL verify against `text`, re-checked, in document order. */
  remaining: CorrectionProposal[];
}

/**
 * Apply exactly one proposal to `text` and return the surviving remainder.
 *
 * Throws when `proposal` does not verify against the text it was handed. That is deliberate:
 * a caller that has drifted must not get a best-effort splice.
 */
export function applyProposal(text: string, proposal: CorrectionProposal, all: readonly CorrectionProposal[]): AppliedProposalResult {
  if (!verifies(text, proposal)) {
    throw new Error(`Correction proposal does not match the text at [${proposal.start}, ${proposal.end}) — refusing to apply it.`);
  }

  const next = text.slice(0, proposal.start) + proposal.proposed + text.slice(proposal.end);
  const delta = proposal.proposed.length - proposal.original.length;

  // Shift only what sits wholly AFTER the edit, then re-verify everything. Anything
  // overlapping the rewritten region cannot survive, and re-verification is what proves it.
  const shifted = all
    .filter((candidate) => candidate !== proposal)
    .map((candidate) => (candidate.start >= proposal.end ? { ...candidate, start: candidate.start + delta, end: candidate.end + delta } : candidate));

  return { text: next, remaining: verifiedProposals(next, shifted) };
}
