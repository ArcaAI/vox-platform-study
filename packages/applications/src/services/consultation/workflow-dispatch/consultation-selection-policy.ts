/**
 * The consultation-selection predicate
 *
 * ## Why this is a module and not two `if`s
 *
 * Selection has exactly two consumers and they must never be able to disagree:
 *
 *   * `assertSelectableForConsultation` answers "may THIS slug govern a consultation?" for one
 *     caller-supplied slug, and turns a violation into a 403;
 *   * `listSelectableForConsultation` answers "which slugs may?" for the whole tenant, and turns
 *     a violation into an omission.
 *
 * Implemented as two independent queries they drift, and the failure is SILENT in both
 * directions: a slug the list advertises but the gate refuses (a caller follows the API's own
 * answer into a 403), or — worse — one the gate allows but the list hides (a capability nobody
 * can discover). So the rule lives here once, and both call it.
 *
 * The VISIBILITY half of the predicate is single-sourced the same way, one layer down:
 * `WorkflowDefinitionRepository.PUBLISHED_AND_ACTIVE` is the one filter object that both
 * `findPublishedBySlug` (the gate's read) and `findActivePublishedByTenant` (the list's read)
 * spread. Between the two, "authorized" and "discoverable" are the same predicate by
 * construction rather than by review.
 *
 * Shape deliberately mirrors `workflow-exposure/exposure-palette-policy.ts`
 * (`exposureBoundaryViolation`), which solves the identical problem for the exposure plane's
 * list/invoke pair: a violation-reason-or-null function rather than a boolean, so the reason is
 * available to the 403 message and the server-side log without either consumer re-deriving it.
 */

/** The palette a consultation-governing graph must declare. */
export const CONSULTATION_PALETTE_KEY = 'consultation';

/**
 * `null` when this definition may govern a consultation; otherwise a clause naming why not,
 * phrased to read after the definition's own name ("Workflow definition 'x' <clause>").
 *
 * Palette is the WHOLE rule, and that is a decision rather than an omission. The dispatcher
 * additionally skips a definition with no `compiledConfig` — but it SKIPS it, degrading to the
 * default engine, rather than refusing the request. Folding that into this predicate would make
 * the list hide a slug the gate still accepts, which is exactly the drift this module exists to
 * prevent. A selectable definition can therefore still degrade at dispatch; that outcome is
 * reported by `GET /consultations/:id/workflow`, which is where "what actually governs" lives.
 */
export function consultationSelectionViolation(definition: { paletteKey: string }): string | null {
  if (definition.paletteKey !== CONSULTATION_PALETTE_KEY) {
    return `is palette '${definition.paletteKey}' and cannot govern a consultation`;
  }

  return null;
}
