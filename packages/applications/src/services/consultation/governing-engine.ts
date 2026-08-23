/**
 * TASK-795 W1 — which agentic-loop engine GOVERNS a consultation.
 *
 * ## The defect this closes
 *
 * The platform has two agentic-loop engines that both write the consultation's
 * draft `ContextItem`:
 *
 *   * **Substrate A** — `ConsultationLoopWorkflow` + `HarnessDocWorkflow`,
 *     signal-with-started lazily by `LoopContextSignalService.handleContextAdded`
 *     on the first context item.
 *   * **Substrate B** — the `WorkflowInterpreter` running a tenant-authored
 *     `consultation`-palette graph, dispatched at consultation OPEN by
 *     `ConsultationWorkflowDispatchService`.
 *
 * Substrate B's `consultation.persistDraft` node calls the SAME `persist_draft`
 * activity `HarnessDocWorkflow` uses. Dispatch was conditional but NOT
 * exclusive, so the moment a `WorkflowAssignment` existed both engines ran and
 * both wrote one document, with no coordination between them.
 *
 * ## Why a persisted marker, and not a lookup
 *
 * The decision must survive: a consultation opened under a tenant workflow has
 * to be recognised as such on a LATER `ContextAdded` signal, in a DIFFERENT
 * process, after a restart. The two candidates were:
 *
 *   1. Query `WorkflowRun` for a row with `trigger: 'consultation open'`.
 *      **Not implementable.** `WorkflowRun` has no consultation linkage at all —
 *      neither the Prisma model (`workflow-run.prisma`) nor `RecordRunStartedInput`
 *      carries a `consultationId`, so there is no key to join on. Adding one is a
 *      `packages/database` schema change this ticket does not own.
 *   2. A durable marker on the consultation row. `Consultation.metadata` is an
 *      existing `Json?` column ("Flexible metadata (scheduling info, external
 *      refs, etc.)") that nothing in `services/consultation/**` reads today, so
 *      the marker needs no migration and no cross-boundary request.
 *
 * (2) is what this module implements. It is deliberately a NAMESPACED key inside
 * the existing object rather than a wholesale replacement: client-supplied
 * metadata from `OpenConsultationRequest` must survive untouched.
 *
 * ## Known limitation, filed rather than hidden
 *
 * `metadata` is client-writable at open, so a caller could in principle post a
 * forged marker and suppress Substrate A for its OWN consultation (denying
 * itself documentation — it cannot reach another tenant's rows). Requiring a
 * non-empty `workflowRunId` raises the bar but does not close it. The real fix is
 * a first-class, platform-owned column on `Consultation`; that is a
 * `packages/database` change and is filed as a requested contract in the ticket
 * README.
 */

/** The one value that means "a tenant-authored workflow governs this consultation". */
export const TENANT_WORKFLOW_GOVERNS_MARKER = 'tenant-workflow';

/** The namespaced key the marker lives under inside `Consultation.metadata`. */
export const GOVERNING_ENGINE_METADATA_KEY = 'governingEngine';

export interface GoverningEngineMarker {
  /** The interpreter run that took ownership. Required — see the forgery note above. */
  readonly workflowRunId: string;
  /** The definition the assignment cascade resolved to, for observability. */
  readonly workflowDefinitionSlug: string;
  /** When the decision was taken, ISO-8601. */
  readonly decidedAt?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `true` when the consultation's metadata carries a WELL-FORMED Substrate-B
 * marker. A malformed or partial marker reads as ABSENT — the fail-safe
 * direction is "Substrate A governs", never "nobody governs".
 */
export function tenantWorkflowGoverns(metadata: unknown): boolean {
  if (!isPlainObject(metadata)) return false;

  const marker = metadata[GOVERNING_ENGINE_METADATA_KEY];
  if (!isPlainObject(marker)) return false;

  return marker.engine === TENANT_WORKFLOW_GOVERNS_MARKER && typeof marker.workflowRunId === 'string' && marker.workflowRunId.length > 0;
}

/**
 * Merge the marker into existing metadata, preserving every other key.
 *
 * A non-object existing value (never produced by `OpenConsultationRequest`,
 * whose `metadata` is `@IsObject()`) is not carried forward — there is no
 * lossless place to put it, and inventing one would be worse than the loud,
 * documented drop.
 */
export function withGoverningEngineMarker(metadata: unknown, marker: GoverningEngineMarker): Record<string, unknown> {
  return {
    ...(isPlainObject(metadata) ? metadata : {}),
    [GOVERNING_ENGINE_METADATA_KEY]: {
      engine: TENANT_WORKFLOW_GOVERNS_MARKER,
      workflowRunId: marker.workflowRunId,
      workflowDefinitionSlug: marker.workflowDefinitionSlug,
      decidedAt: marker.decidedAt ?? new Date().toISOString(),
    },
  };
}
