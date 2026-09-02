/**
 * TASK-858 lane A — the consultation's OWN workflow selection, durable from the
 * moment the consultation is created.
 *
 * ## Why this exists beside `governingEngine` rather than instead of it
 *
 * TASK-813 lets a caller pick `workflowDefinitionSlug` at session open. The pick
 * is authorized in `ConsultationService.getOrCreate` (`assertSelectableForConsultation`),
 * but the only place it was ever WRITTEN DOWN is
 * `Consultation.metadata.governingEngine` — and `governing-engine.ts` requires a
 * non-empty `workflowRunId`, which only exists when the durable dispatch
 * SUCCEEDED. So on every deployment where Temporal is unreachable, the harness
 * gateway is down, or no claim-check storage is configured, the dispatcher
 * returns `dispatched: false` and the authorized selection evaporates: nothing on
 * the row records which workflow the clinician chose.
 *
 * That is precisely the case in which the REALTIME lane still runs (the substrate
 * gate stands this engine down only when a well-formed `governingEngine` marker
 * IS present), so it is exactly the case in which the selection needs to survive.
 * Hence a second, independent key written at CREATE time, before and regardless
 * of dispatch.
 *
 * ## Two keys, two different claims — neither is a copy of the other
 *
 * | Key | Claim | Written when |
 * |---|---|---|
 * | `governingEngine` | "the durable interpreter run `<id>` OWNS this consultation" | after a run actually started |
 * | `workflowSelection` | "the clinician ASKED for this workflow" | at consultation create, if a slug was authorized |
 *
 * A request can therefore be recorded as *asked for* and never *dispatched*, and
 * the two readers stay honest about which they are reporting.
 *
 * ## Forgery, and why re-verification (not stripping) is the answer
 *
 * `Consultation.metadata` is client-writable at open (`OpenConsultationRequest.metadata`),
 * so a caller could post this key themselves rather than using the selector. That
 * buys them nothing: every reader re-resolves the slug through the tenant-scoped
 * `findPublishedBySlug` plus the same `consultationSelectionViolation` palette
 * predicate the authorization gate uses, so a forged value can only ever name a
 * workflow the caller was already entitled to select, in their own tenant. The
 * key is therefore NOT stripped from caller metadata — doing so would mutate a
 * field TASK-795 deliberately preserves untouched, to close nothing.
 */

import type { JsonObject } from '@arcaai/domains';

/** The namespaced key the selection lives under inside `Consultation.metadata`. */
export const WORKFLOW_SELECTION_METADATA_KEY = 'workflowSelection';

export interface WorkflowSelectionMarker {
  /** The definition slug the caller selected and the gate authorized. */
  readonly workflowDefinitionSlug: string;
  /** When it was selected, ISO-8601. */
  readonly selectedAt?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The selection recorded on a consultation, or `null` when there is none.
 *
 * A malformed or empty-slug marker reads as ABSENT, matching
 * `readGoverningEngineMarker`'s rule: the fail-safe direction here is "fall back
 * to the assignment cascade", never "no lane at all".
 */
export function readWorkflowSelectionMarker(metadata: unknown): WorkflowSelectionMarker | null {
  if (!isPlainObject(metadata)) return null;

  const marker = metadata[WORKFLOW_SELECTION_METADATA_KEY];
  if (!isPlainObject(marker)) return null;

  if (typeof marker.workflowDefinitionSlug !== 'string' || marker.workflowDefinitionSlug.length === 0) return null;

  return {
    workflowDefinitionSlug: marker.workflowDefinitionSlug,
    selectedAt: typeof marker.selectedAt === 'string' ? marker.selectedAt : undefined,
  };
}

/**
 * Merge the selection into existing metadata, preserving every other key —
 * deliberately the same shape as `withGoverningEngineMarker`, because the
 * requirement is the same one: client-supplied metadata from
 * `OpenConsultationRequest` must survive untouched.
 */
export function withWorkflowSelectionMarker(metadata: unknown, workflowDefinitionSlug: string, selectedAt?: string): JsonObject {
  return {
    ...(isPlainObject(metadata) ? metadata : {}),
    [WORKFLOW_SELECTION_METADATA_KEY]: {
      workflowDefinitionSlug,
      selectedAt: selectedAt ?? new Date().toISOString(),
    },
  };
}
