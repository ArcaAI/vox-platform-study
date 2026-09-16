/**
 * Consultation-open workflow dispatch.
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
 *   - NO assignment resolves -> `dispatched: false`, Substrate A keeps the consultation
 *     (today's behaviour, unchanged — this is the default and must stay the default);
 *   - an assignment resolves -> Substrate B is dispatched, and a DURABLE marker is written to
 *     `Consultation.metadata` so `LoopContextSignalService` stands Substrate A down.
 *
 * A tenant that has authored nothing sees exactly the behaviour it sees today.
 *
 * ## What "exclusive" meant before, and what it means now
 *
 * This paragraph used to claim exclusivity that the code did not implement. Dispatch was
 * conditional — `dispatched: false` with no assignment — but NOTHING gated Substrate A on the
 * result, so with an assignment present both engines ran and both wrote one `ContextItem`. The
 * claim was latent-only because zero `WorkflowAssignment` rows existed.
 *
 * makes it true. The decision is taken here, once, at open, and PERSISTED (see
 * `../governing-engine.ts` for why a marker and not a `WorkflowRun` query: that table has no
 * consultation linkage to join on). `LoopContextSignalService.loopAllowedFor` reads it before
 * every signal, so the decision survives a later signal, a different process, and a restart.
 *
 * The two halves fail in opposite directions ON PURPOSE, both towards "Substrate A documents
 * this consultation": the write happens only AFTER the interpreter run actually starts, and the
 * read treats an unreadable marker as absent. A consultation with no documentation is a worse
 * clinical outcome than one documented by the default engine.
 */

import { SelectableConsultationWorkflowListResponse } from './dto';

/** Why a consultation is (or is not) governed by a tenant-authored graph. */
export interface ConsultationWorkflowDispatchResult {
  /** True only when a tenant-authored graph was actually started for this consultation. */
  readonly dispatched: boolean;
  /**
   * Which cascade tier supplied the definition, or `platform-default` when none did.
   *
   * adds `caller-selected`: the cascade was not consulted at all because the caller
   * named a definition at open and it was authorized. Kept as a distinct value rather than
   * folded into `tenant` so an observer reading a log line or the discovery route can tell a
   * deliberate selection from an assignment that happened to resolve to the same slug.
   */
  readonly source: 'department' | 'tenant' | 'platform-default' | 'caller-selected';
  /** The resolved definition slug, when one resolved. */
  readonly workflowDefinitionSlug: string | null;
  /** The started interpreter run id, when one was started. */
  readonly runId: string | null;
  /**
   * whether the durable "Substrate B governs" marker was persisted on the
   * consultation.
   *
   * `dispatched: true` with `governanceRecorded: false` is the one residual this design leaves:
   * the interpreter run started, but the marker write failed, so Substrate A will NOT stand down
   * and both engines will write the document. It is logged at ERROR and reported here rather than
   * swallowed. `false` on a non-dispatched result simply means there was nothing to record.
   */
  readonly governanceRecorded: boolean;
  /**
   * Set when an assignment resolved but dispatch could not proceed (e.g. no claim-check storage).
   * The consultation still runs under Substrate A — dispatch is best-effort by design, because a
   * failure here must never block a clinician from opening a consultation.
   */
  readonly skippedReason?: string;
  /**
   * the `AsrPipeline` id the tenant's assigned `stt`-palette graph
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
  /**
   * TASK-891 — the consultation's own parent link, when it has one. Threaded in rather than
   * re-read: dispatch is best-effort by contract, and a DB read here would change its failure
   * profile (this service must never fail an open because it could not re-fetch a fact its
   * caller already has). Used ONLY to derive the reserved `visit-type:<key>` selector tag
   * (`VisitTypeService.forConsultation`, OD-2/OD-3) for the consultation-palette cascade —
   * absent (`undefined`/`null`) means "not a follow-up", not "unknown", so an omitted value
   * degrades to `visit-type:new-visit` rather than to a failure.
   */
  readonly parentConsultationId?: string | null;
  /**
   * TASK-951 §D-3 — the visit type RECORDED on the consultation (`metadata.visitType`), when the
   * caller stated one through its context schema.
   *
   * Threaded in for exactly the reason `parentConsultationId` is: this service is best-effort by
   * contract, so it must not grow a read. It RANKS ABOVE the parent link in
   * `VisitTypeService.forConsultation`, which is the whole point — a client that says "revisit"
   * for a same-day review with no parent row in HOPE selects the revisit template, and one that
   * says nothing keeps the pre-TASK-951 derivation exactly.
   *
   * Absent (`undefined`/`null`) means "the caller stated nothing", never "new visit".
   */
  readonly visitType?: string | null;
  /**
   * TASK-951 §D-6 — the VALIDATED `open.context`, forwarded as the interpreter run's `payload`
   * so a graph's `trigger.context.*` references resolve to what the client actually sent.
   *
   * Before this, `_authored_context(run_payload)` was `{}` for every consultation-open run, so a
   * `core.trigger` bound to the tenant's schema saw nothing and a `core.condition` on
   * `trigger.context.visit_type` could never be true.
   *
   * It rides the run's `payload` channel, which the dispatcher strips every
   * `RESERVED_RUN_IDENTITY_KEYS` entry out of before forwarding — identity travels on `subject`
   * and only there, so threading client-authored content here cannot forge a subject.
   */
  readonly authoredContext?: Record<string, unknown>;
  /**
   * the caller's workflow selection, taking precedence over the assignment
   * cascade for the `consultation` palette (the INDEPENDENT `stt`-palette assignment is
   * unaffected — the two lanes are separate).
   *
   * MUST already have passed {@link IConsultationWorkflowDispatchService.assertSelectableForConsultation}.
   * This field is not a second authorization seam: dispatch is best-effort by contract and
   * swallows its own failures, so a gate placed here would turn a refused request into a silent
   * fallback. It is re-VERIFIED here (published + right palette) for the same reason the cascade
   * result is — a reference across a service boundary is re-checked, never trusted — but the
   * refusal the caller sees is raised earlier, before anything is written.
   */
  readonly workflowDefinitionSlug?: string | null;
}

/**
 * What a consultation open needs to know about the workflow that WOULD govern it, before it
 * writes anything.
 */
export interface PreviewGoverningWorkflowInput {
  readonly tenantId: string;
  readonly departmentId?: string | null;
  /** The caller's selection, which replaces the cascade exactly as it does at dispatch. */
  readonly workflowDefinitionSlug?: string | null;
  /** Feeds the reserved `visit-type:<key>` selector tag, same derivation as dispatch. */
  readonly parentConsultationId?: string | null;
  readonly visitType?: string | null;
}

/** A CONCLUSIVE answer about the governing workflow. Anything less is `null`, never this. */
export interface GoverningWorkflowPreview {
  readonly workflowDefinitionSlug: string;
  /**
   * The payload schema the trigger would validate this run's context against — the tenant's
   * CURRENT pin for a follow-latest trigger, the frozen bytes for a pinned one.
   */
  readonly resolved: Record<string, unknown>;
  /** Which schema version `resolved` came from, when the artifact or the pin records one. */
  readonly boundSchemaVersion: number | null;
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

  /**
   * the tenant's SELECTABLE set: every definition that would pass
   * {@link assertSelectableForConsultation} right now.
   *
   * The gate and this list are one predicate with two consumers
   * (`consultation-selection-policy.ts`), which is the whole point of the shape: implemented as
   * two independent queries they drift, and both drift directions fail silently — a slug the
   * list advertises that the gate refuses, or one the gate allows that the list hides.
   *
   * `tenantId` is the caller's resolved tenant, never a request field. There is no cross-tenant
   * identifier on this surface to hide, so no 404-over-403 case arises; an empty list is a real
   * answer, not an error.
   */
  listSelectableForConsultation(tenantId: string): Promise<SelectableConsultationWorkflowListResponse>;

  /**
   * point 6 — authorize a caller-supplied workflow selection BEFORE the
   * consultation is written. Resolves silently when the selection is allowed; otherwise throws.
   *
   * Two failure directions, and they must never be swapped:
   *
   *   * `NotFoundException` (404) — the definition is INVISIBLE to `tenantId`. Another tenant's
   *     slug, an unknown slug, and an unpublished/inactive one are deliberately
   *     indistinguishable: a 403 for any of them would confirm the slug exists (404-over-403).
   *   * `ForbiddenException` (403) — the definition is VISIBLE to this tenant (published +
   *     active, so it already appears on the tenant's own workflow-authoring surface, `GET
   *     admin/workflow-definitions`) but belongs to a palette that cannot govern a consultation.
   *     `GET /workflows`, the public exposure-plane listing, is NOT that visibility surface — it
   *     excludes every palette but `summarization` (`EXPOSURE_ALLOWED_PALETTES`), so a `consultation`
   *     or `stt` selection refused here was never listed there either. Hiding a resource the caller
   *     can already see (via authoring) would be theatre, and a 404 here would send an author
   *     hunting for a row that is plainly there.
   *
   * `tenantId` is the caller's resolved tenant, never a request field.
   */
  assertSelectableForConsultation(tenantId: string, workflowDefinitionSlug: string): Promise<void>;

  /**
   * Which workflow would govern a consultation opened right now, and which payload schema its
   * trigger would check — resolved through the SAME cascade, the same selectability predicate
   * and the same effective-schema resolution `dispatchForConsultation` uses, and starting
   * nothing.
   *
   * `open` calls this to refuse an incompatible context before it writes a row. That is only
   * safe while the two answers cannot disagree, which is why this is a method here rather than a
   * second cascade at the call site.
   *
   * NEVER throws. `null` means the check is INCONCLUSIVE — no assignment, an unpublished or
   * unreadable definition, a trigger that froze no schema — and an inconclusive check must let
   * the open proceed exactly as it does today, ungoverned. Only a conclusive answer may refuse.
   */
  previewGoverningWorkflow(input: PreviewGoverningWorkflowInput): Promise<GoverningWorkflowPreview | null>;
}

export const IConsultationWorkflowDispatchService = Symbol('IConsultationWorkflowDispatchService');
