/**
 * Bounding the PRIOR-VISIT summary a re-visit consultation carries into its prompt.
 *
 * The carry-forward DECISION is the assigned graph's `carryForward` binding (TASK-882; read by
 * `ConfigResolver.resolveRevisitCarryForwardEnabled`). What is bounded here is the CONTENT:
 * a whole prior note is real prompt budget, and an unbounded carry is how a re-visit prompt
 * grows without limit across a long care episode.
 */

/** Hard cap on the carried prior-visit summary. */
export const PRIOR_VISIT_SUMMARY_MAX_CHARS = 15_000;

/** Appended when the prior-visit summary is cut at the cap. */
export const PRIOR_VISIT_SUMMARY_TRUNCATION_MARKER = '…[prior visit summary truncated]';

/**
 * Bound a carried prior-visit summary, marking the cut so neither the model nor a reviewer can
 * mistake a truncated note for a complete one.
 *
 * Applied at BOTH ends on purpose: the producer (`HarnessInternalService.assemble`) caps what
 * it carries, and prompt assembly caps again immediately before the text reaches the prompt.
 * Assembly is the shared entry point for every caller, so the second application is what
 * makes the bound a property of the PROMPT rather than of one producer.
 */
export function truncatePriorVisitSummary(text: string): string {
  if (text.length <= PRIOR_VISIT_SUMMARY_MAX_CHARS) return text;
  return `${text.slice(0, PRIOR_VISIT_SUMMARY_MAX_CHARS)}${PRIOR_VISIT_SUMMARY_TRUNCATION_MARKER}`;
}
