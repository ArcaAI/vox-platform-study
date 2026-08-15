import { GenerateParams, GenerationDecision, GenerationTrigger } from './types';
import { ConsultationPipelineConfig } from '../events/consultation.events';

/**
 * TASK-704 — Generator Entry-Point Seam.
 *
 * The single seam every note-generation entry point routes through.
 * `harnessEnabled` is read in exactly one runtime location:
 * `NoteGenerationService.generate` (enforced by the grep-gate test in
 * `__tests__/harness-enabled-single-reader.grep-gate.test.ts`).
 */
export interface INoteGenerationService {
  /**
   * Decide (and, when routing to harness, START) generation for one trigger.
   *
   * Resolution:
   *   1. Resolve the consultation's pipeline config (`resolveConfig`).
   *   2. If the trigger has no harness equivalent (PRE_SUMMARY /
   *      COMPREHENSIVE_SUMMARY) → `{ generator: 'legacy', reason: 'harness-not-supported-for-trigger' }`.
   *   3. If `config.harnessEnabled` is false → `{ generator: 'legacy', reason: 'harnessEnabled-false' }`.
   *   4. Otherwise → start the harness document workflow and return
   *      `{ generator: 'harness', harnessJobId }`.
   *
   * The harness-start call is NOT optional-chained: a missing
   * `HarnessGatewayService` throws (surfacing as a job failure / thrown
   * exception at the caller) rather than silently logging success and
   * producing zero notes — the fix for the §2.3 silent-drop defect.
   */
  generate(trigger: GenerationTrigger, params: GenerateParams): Promise<GenerationDecision>;

  /**
   * Resolve the full per-consultation pipeline config through the same
   * cascade `ConsultationEventHandler.resolvePipelineConfig` used before
   * TASK-704 (moved here verbatim). Exposed publicly because callers still
   * need the non-routing knobs (`autoSummaryEnabled`, `dnaStyleId`,
   * `summaryTemplate`, ...) for their own trigger-specific request assembly.
   */
  resolveConfig(consultationId: string): Promise<ConsultationPipelineConfig>;
}

export const INoteGenerationService = Symbol('INoteGenerationService');
