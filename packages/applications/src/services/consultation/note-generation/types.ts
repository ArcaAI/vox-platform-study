/**
 * Generator Entry-Point Seam.
 *
 * Types for `NoteGenerationService`, the single seam every note-generation
 * entry point routes through. See `note-generation.service.ts` for the
 * decision logic and `../../../../../
 * for the full requirement analysis.
 */

/**
 * Every place a consultation note can be produced, collapsed to the four
 * DECISION kinds the seam actually needs (the seven concrete entry points
 * enumerated in the map onto these):
 *
 *   - TRANSCRIPTION_CREATED — entry #1 (auto-pipeline, ConsultationEventHandler)
 *   - SUMMARY_REGENERATE — entry #2 (sync generateSummary) + #4 (async generateSummaryAsync)
 *   - PRE_SUMMARY — entry #3 (sync generatePreSummary) + #5 (async generatePreSummaryAsync)
 *   - COMPREHENSIVE_SUMMARY — entry #6 (sync generateComprehensiveSummary) + #7 (async generateComprehensiveSummaryAsync)
 *
 * PRE_SUMMARY and COMPREHENSIVE_SUMMARY have no harness-side equivalent today
 * (confirmed in of the ticket — no Temporal workflow in apps/harness is
 * named for either) — `generate()` always resolves them to `legacy`.
 */
export enum GenerationTrigger {
  TRANSCRIPTION_CREATED = 'TRANSCRIPTION_CREATED',
  SUMMARY_REGENERATE = 'SUMMARY_REGENERATE',
  PRE_SUMMARY = 'PRE_SUMMARY',
  COMPREHENSIVE_SUMMARY = 'COMPREHENSIVE_SUMMARY',
}

/** Triggers with a harness-side equivalent today. Kept in one place so a
 * future harness capability for PRE_SUMMARY/COMPREHENSIVE_SUMMARY is a
 * one-line addition here rather than a rewrite of `generate()`'s branching. */
export const HARNESS_SUPPORTED_TRIGGERS: ReadonlySet<GenerationTrigger> = new Set([
  GenerationTrigger.TRANSCRIPTION_CREATED,
  GenerationTrigger.SUMMARY_REGENERATE,
]);

/**
 * Why the seam fell back to the legacy generator. TASK-882: `'harnessEnabled-false'` is gone
 * with `pipeline.harnessEnabled` — `false` routed to a generator that no longer existed, so it
 * had no valid meaning; every harness-supported trigger now routes to the harness.
 */
export type GenerationFallbackReason =
  /** The trigger has no harness workflow today (PRE_SUMMARY / COMPREHENSIVE_SUMMARY). */
  'harness-not-supported-for-trigger';

export interface GenerationDecisionHarness {
  generator: 'harness';
  /** The harness-doc job id minted for this start call (SSE channel key). */
  harnessJobId: string;
}

export interface GenerationDecisionLegacy {
  generator: 'legacy';
  reason: GenerationFallbackReason;
}

/**
 * The seam's decision. The seam OWNS the decision and, on `'harness'`,
 * already started the harness workflow (side effect included) — the caller
 * only needs to skip its own legacy generation body. On `'legacy'` the seam
 * did nothing; the caller runs its existing legacy generation exactly as
 * before.
 */
export type GenerationDecision = GenerationDecisionHarness | GenerationDecisionLegacy;

/**
 * Params for `NoteGenerationService.generate()`. Trigger-specific request
 * assembly (transcript loading, DNA-redaction resolution) stays with the
 * caller and is passed through here — the seam only owns the generator
 * decision, not every side effect of building the harness start context.
 */
export interface GenerateParams {
  consultationId: string;
  tenantId: string;
  userId?: string;
  /** Threaded into the harness start context's correlationId when routed to harness. */
  correlationId?: string;
  contextItemId?: string;
  transcriptText?: string;
  redactionRules?: Record<string, unknown>[];
}
