/**
 * Consultation-open workflow dispatch (TASK-789, finding C-1).
 *
 * ## Why this exists
 *
 * `WorkflowDefinition` + `WorkflowAssignment` + the 13-node `consultation` palette were all
 * built, but nothing ever DISPATCHED them for a consultation:
 *
 *   - `WorkflowAssignmentService.resolve()` had no production caller (tests only);
 *   - only `'api invoke'` and `'workbench sandbox'` were ever stamped as a `WorkflowRun.trigger`,
 *     while `'consultation open'` existed solely in `@ApiProperty` description strings.
 *
 * So a tenant admin could author and publish a consultation graph in Workflow Studio and it would
 * govern nothing. This service is the missing seam: it makes the cascade real and makes
 * `'consultation open'` a value the system actually stamps.
 *
 * ## The safety rule that shapes this design
 *
 * A consultation is ALREADY governed by Substrate A (`ConsultationLoopWorkflow` +
 * `HarnessDocWorkflow`), which signal-with-starts lazily on the first context item. Substrate B's
 * `consultation.persistDraft` node calls the SAME `persist_draft` activity Substrate A uses, so
 * running both against one consultation would produce two writers on one `ContextItem`.
 *
 * Therefore dispatch is **opt-in and exclusive**:
 *
 *   - NO assignment resolves  -> `dispatched: false`, Substrate A keeps the consultation
 *     (today's behaviour, unchanged — this is the default and must stay the default);
 *   - an assignment resolves  -> Substrate B is dispatched and the decision is recorded, so which
 *     engine governs is an explicit, observable fact rather than an implicit default.
 *
 * A tenant that has authored nothing sees exactly the behaviour it sees today.
 */

/** Why a consultation is (or is not) governed by a tenant-authored graph. */
export interface ConsultationWorkflowDispatchResult {
  /** True only when a tenant-authored graph was actually started for this consultation. */
  readonly dispatched: boolean;
  /** Which cascade tier supplied the definition, or `platform-default` when none did. */
  readonly source: 'department' | 'tenant' | 'platform-default';
  /** The resolved definition slug, when one resolved. */
  readonly workflowDefinitionSlug: string | null;
  /** The started interpreter run id, when one was started. */
  readonly runId: string | null;
  /**
   * Set when an assignment resolved but dispatch could not proceed (e.g. no claim-check storage).
   * The consultation still runs under Substrate A — dispatch is best-effort by design, because a
   * failure here must never block a clinician from opening a consultation.
   */
  readonly skippedReason?: string;
  /**
   * TASK-790 W4 (TASK-789 H-5) — the `AsrPipeline` id the tenant's assigned `stt`-palette graph
   * compiled to, or `null` when no `stt` graph is assigned (or it has no compiled pipeline yet).
   *
   * INDEPENDENT of `dispatched`: the STT and consultation lanes are separate assignments, so a
   * tenant may have one, both, or neither. `null` means "fall back to the tenant's existing
   * pipeline resolution" (`resolveDefaultPipelineId`), never an error.
   */
  readonly sttPipelineId: string | null;
}

export interface DispatchForConsultationInput {
  readonly consultationId: string;
  readonly tenantId: string;
  readonly departmentId?: string | null;
  /** The clinician opening the consultation — threaded into the run payload as identity. */
  readonly userId: string;
  readonly externalPatientId?: string | null;
}

export interface IConsultationWorkflowDispatchService {
  /**
   * Resolve the tenant's `consultation`-palette assignment and, when one exists, start a
   * `WorkflowInterpreter` run stamped `trigger: 'consultation open'`.
   *
   * NEVER throws for an absent assignment or a dispatch failure — a consultation must open even
   * when no graph governs it. Genuine programming errors (missing tenant) still throw.
   */
  dispatchForConsultation(input: DispatchForConsultationInput): Promise<ConsultationWorkflowDispatchResult>;
}

export const IConsultationWorkflowDispatchService = Symbol('IConsultationWorkflowDispatchService');
