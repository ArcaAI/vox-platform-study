import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConsultationRepository, generateId, WorkflowDefinitionRepository } from '@arcaai/domains';
import { IWorkflowAssignmentService } from '../../workflow-assignment/IWorkflowAssignmentService';
import { IWorkflowRunCompletionPort } from '../../workflow-run/IWorkflowRunCompletionPort';
import { IWorkflowRunService } from '../../workflow-run/IWorkflowRunService';
import { consultationDispatchSessionId } from '../../workflow-run/workflow-run.service';
import { HarnessGatewayService } from '../harness/harness-gateway.service';
import { IS3Service } from '../../baseServices/storage/s3/IS3Service';
import { CLAIM_CHECK_BUCKET, mintCompiledConfigClaimCheckRef } from '../../workflow-exposure/claim-check';
import { SttPipelineResolverService } from '../../workflow-definition/resolvers/stt-pipeline-resolver.service';
import { withGoverningEngineMarker } from '../governing-engine';
import { DEFAULT_VISIT_TYPE_SERVICE, VisitTypeService } from '../visit-type/visit-type.service';
import { CORE_PALETTE_KEY } from '@arcaai/workflow-contract';
import { consultationSelectionViolation } from './consultation-selection-policy';
import { SelectableConsultationWorkflowListResponse } from './dto';
import {
  ConsultationWorkflowDispatchResult,
  DispatchForConsultationInput,
  IConsultationWorkflowDispatchService,
} from './IConsultationWorkflowDispatchService';

/**
 * Dispatches a tenant-authored `consultation`-palette workflow at consultation open,
 * and RECORDS that decision on the consultation so Substrate A stands down.
 * See `IConsultationWorkflowDispatchService` for why this is opt-in and exclusive.
 */
@Injectable()
export class ConsultationWorkflowDispatchService implements IConsultationWorkflowDispatchService {
  private readonly logger = new Logger(ConsultationWorkflowDispatchService.name);

  constructor(
    @Inject(IWorkflowAssignmentService) private readonly assignments: IWorkflowAssignmentService,
    private readonly definitionRepository: WorkflowDefinitionRepository,
    // carries the durable governing-engine marker. REQUIRED, not
    // `@Optional()`: this is the exclusivity gate's write half, and a module that
    // forgot `CoreDatabaseModule` must fail loudly at boot rather than quietly
    // dispatch Substrate B while leaving Substrate A running alongside it.
    @Inject(ConsultationRepository) private readonly consultationRepository: ConsultationRepository,
    @Inject(IWorkflowRunService) private readonly workflowRunService: IWorkflowRunService,
    @Inject(HarnessGatewayService) private readonly harnessGateway: HarnessGatewayService,
    @Optional() @Inject(IS3Service) private readonly s3Service?: IS3Service,
    // the FIRST production injector of this resolver, which found
    // "exported for a future consumer, injected nowhere". `@Optional()` so unit fixtures still
    // construct; production DI (WorkflowDefinitionServiceModule) supplies it.
    @Optional() private readonly sttPipelineResolver?: SttPipelineResolverService,
    // TASK-891 — derives the reserved `visit-type:<key>` selector tag (OD-2/OD-3). Holds no
    // state and no dependency (see the class header on `VisitTypeService`), so `@Optional()`
    // with the shared `DEFAULT_VISIT_TYPE_SERVICE` fallback follows the same pattern every
    // other consumer of this service already uses.
    @Optional() @Inject(VisitTypeService) private readonly visitTypes?: VisitTypeService,
    // TASK-946 D3 — the gateway's run-completion watcher, named as a PORT because this package
    // must never import `apps/api` (see `IWorkflowRunCompletionPort`). `@Optional()`: a context
    // built without the gateway module degrades to the pre-existing "reconciled by the next
    // status read" behaviour rather than failing to construct.
    @Optional() @Inject(IWorkflowRunCompletionPort) private readonly runCompletion?: IWorkflowRunCompletionPort,
  ) {}

  /**
   * point 6 — the selector authorization gate. See
   * `IConsultationWorkflowDispatchService.assertSelectableForConsultation` for the 404/403 split
   * and why it is that way round.
   *
   * The whole gate is one tenant-scoped read plus one palette comparison, and that is
   * deliberate: `findPublishedBySlug` already filters `tenantId` + `PUBLISHED` + `isActive` +
   * `resourceStatus: ENABLED`, so every "the caller may not see this" case collapses into a
   * single `null` with no branch that could accidentally answer differently for a foreign slug
   * than for an unknown one.
   */
  async assertSelectableForConsultation(tenantId: string, workflowDefinitionSlug: string): Promise<void> {
    const definition = await this.definitionRepository.findPublishedBySlug(tenantId, workflowDefinitionSlug);

    // Invisible to this tenant: foreign, unknown, unpublished, inactive, or soft-deleted. One
    // answer for all of them — the message names the slug the caller already sent, and nothing
    // else, so it discloses nothing about what this or any other tenant has authored.
    if (!definition) {
      throw new NotFoundException(`Workflow definition '${workflowDefinitionSlug}' not found`);
    }

    // Visible, but not a consultation-governing graph. A `summarization` or `stt` definition has
    // no consultation nodes: dispatching it would bind nothing and quietly leave the document
    // unwritten, so this is refused up front rather than degraded at dispatch.
    //
    // The rule itself is NOT written here — `listSelectableForConsultation` asks the same
    // function, so the set this gate authorizes and the set that route advertises cannot drift.
    const violation = consultationSelectionViolation(definition);
    if (violation) {
      throw new ForbiddenException(`Workflow definition '${workflowDefinitionSlug}' ${violation}`);
    }
  }

  /**
   * the DISCOVERY half of the same question: which slugs would pass the gate
   * above, for this tenant, right now.
   *
   * Selection shipped without it, so the contract was "guess a slug, get a 404/403". The fix is
   * not a second query that reproduces the gate's conditions — it is the SAME predicate applied
   * to the whole tenant instead of to one slug:
   *
   *   * visibility — `findActivePublishedByTenant` spreads the identical `PUBLISHED_AND_ACTIVE`
   *     filter object `findPublishedBySlug` spreads, so nothing invisible to the gate is listed;
   *   * selectability — `consultationSelectionViolation`, the function the gate calls.
   *
   * `tenantId` is the caller's resolved tenant, never a request field, so there is no
   * cross-tenant identifier to hide: a caller simply cannot address another tenant's set. The
   * answer for a tenant that has authored nothing is an empty list, which is a real answer and
   * not an error.
   */
  async listSelectableForConsultation(tenantId: string): Promise<SelectableConsultationWorkflowListResponse> {
    const published = await this.definitionRepository.findActivePublishedByTenant(tenantId);
    const selectable = published.filter((definition) => consultationSelectionViolation(definition) === null);
    const tenantDefaultSlug = await this.resolveTenantDefaultSlug(tenantId);

    return {
      data: selectable.map((definition) => ({
        slug: definition.slug,
        name: definition.name,
        description: definition.description ?? null,
        // Matched against the SELECTABLE set, never asserted from the assignment alone: a tenant
        // default that has since been unpublished (or was never a consultation graph) must not
        // add a phantom entry, or the list would advertise a slug the gate refuses.
        isTenantDefault: definition.slug === tenantDefaultSlug,
      })),
    };
  }

  /**
   * Which slug the TENANT-tier assignment names, or `null`.
   *
   * Best-effort by design, and the direction matters: the selectable set IS the answer this
   * route owes; the default marker is decoration on it. An assignment store that cannot be read
   * must therefore cost the caller the marker, never the list — a discovery route that fails
   * because a nice-to-have failed would send an integrator hunting for a problem in the part
   * that worked.
   *
   * Resolved with `departmentId: null` deliberately — see
   * `SelectableConsultationWorkflowResponse.isTenantDefault` for why this route answers the
   * tenant tier rather than taking a department from the caller.
   */
  private async resolveTenantDefaultSlug(tenantId: string): Promise<string | null> {
    try {
      const assignment = await this.assignments.resolve(tenantId, CORE_PALETTE_KEY, null);
      return assignment.workflowDefinitionSlug;
    } catch (error) {
      this.logger.warn({
        message: 'Tenant default workflow could not be resolved — listing the selectable set without a default marker',
        tenantId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async dispatchForConsultation(input: DispatchForConsultationInput): Promise<ConsultationWorkflowDispatchResult> {
    const { consultationId, tenantId, departmentId, userId, externalPatientId, workflowDefinitionSlug, parentConsultationId } = input;

    // resolved FIRST, and unconditionally, because the two palettes are separate
    // assignments: a tenant may assign an `stt` graph and no `consultation` graph. Putting this
    // after the early return below would silently skip the STT lane for exactly that tenant.
    //
    // Deliberately NOT tagged with the visit-type selector below: visit-type/department tags
    // select a documentation TEMPLATE (OD-2/OD-3), an axis the STT palette — which picks an ASR
    // pipeline — has no opinion about.
    const sttPipelineId = await this.resolveSttPipelineId(tenantId, departmentId ?? null);

    // point 5 — a caller selection REPLACES the consultation-palette cascade.
    // `assignments.resolve` is not called at all in that case: consulting it and then discarding
    // the answer would put a second, invisible slug in the logs for an operator to mistake for
    // the one that ran.
    const resolved: { workflowDefinitionSlug: string | null; source: ConsultationWorkflowDispatchResult['source'] } = workflowDefinitionSlug
      ? { workflowDefinitionSlug, source: 'caller-selected' }
      : await this.assignments.resolve(tenantId, CORE_PALETTE_KEY, departmentId ?? null, this.visitTypeSelectorTags(tenantId, parentConsultationId));

    // No tier assigned anything -> Substrate A keeps the consultation. This is the DEFAULT and
    // must stay the default: a tenant that has authored nothing sees today's behaviour exactly.
    if (!resolved.workflowDefinitionSlug) {
      return { dispatched: false, source: resolved.source, workflowDefinitionSlug: null, runId: null, governanceRecorded: false, sttPipelineId };
    }

    const notDispatched = (skippedReason: string): ConsultationWorkflowDispatchResult => ({
      dispatched: false,
      source: resolved.source,
      workflowDefinitionSlug: resolved.workflowDefinitionSlug,
      runId: null,
      governanceRecorded: false,
      skippedReason,
      sttPipelineId,
    });

    try {
      const definition = await this.definitionRepository.findPublishedBySlug(tenantId, resolved.workflowDefinitionSlug);

      // `resolve()` already re-checks publication, but it is a REFERENCE across a service
      // boundary — re-verify rather than trust, and never dispatch a graph from another palette
      // into a consultation (an `stt` graph has no consultation nodes and would bind nothing).
      if (!definition) return notDispatched('assignment names no ACTIVE PUBLISHED definition');

      // Same predicate as the gate and the discovery list — a third restatement here is exactly
      // how the three answers would come apart.
      const violation = consultationSelectionViolation(definition);
      if (violation) return notDispatched(`assigned definition ${violation}`);
      if (!definition.compiledConfig) return notDispatched('definition has no compiled configuration');
      if (!this.s3Service) return notDispatched('no claim-check storage backend is configured');

      const configRef = await mintCompiledConfigClaimCheckRef(definition.compiledConfig, CLAIM_CHECK_BUCKET, (b, key, data, contentType) =>
        this.s3Service!.putFile(b, key, data, contentType),
      );

      const runId = generateId();
      // NOT the exposure plane's `interpreterSessionId` — this prefix is what `findRunOrThrow`
      // falls back to, so a consultation-governed run resolves on `workflows/{slug}/runs/…`.
      const sessionId = consultationDispatchSessionId(runId);

      // Ownership anchor BEFORE dispatch — same ordering rule as `WorkflowExposureService.invoke`:
      // a durable row for a run that fails to start is recoverable; a started run nothing can
      // attribute to a tenant is not.
      await this.workflowRunService.recordRunStarted({
        tenantId,
        workflowVersionId: definition.id,
        workflowSlug: definition.slug,
        workflowVersionNumber: definition.versionNumber,
        definitionName: definition.name,
        sessionId,
        runId,
        trigger: 'consultation open',
        isSandbox: false,
      });

      // The identity every consultation node reads from `run_payload`
      // (`interpreter/nodes/_consultation_shared.py`). Omitting it is what made look
      // like a broken invoke path: `input.context_binding` is `critical=True`, so a run without
      // identity fails at its first node.
      //
      // lane A moved it from `payload` to `subject`. It is the SAME three values
      // reaching the same `run_identity(...)` readers — the dispatcher re-stamps them into
      // `run_payload` — but they now travel on a channel a caller cannot compose. This call site
      // was always safe (its `consultationId` comes from a consultation the gateway just opened,
      // not from a request body); it moves because the dispatcher now STRIPS those keys out of
      // `payload` unconditionally, and a conditional strip is one somebody reasons around.
      await this.harnessGateway.startWorkflowRun({
        runId,
        sessionId,
        workflowVersionId: definition.id,
        tenantId,
        configRef,
        sandbox: false,
        subject: { consultationId, userId, externalPatientId: externalPatientId ?? undefined },
      });

      // TASK-946 D3 — attach the terminal-status watcher for THIS run. Until now it was
      // attached only by the workflows-plane controller, so a consultation-dispatched run had no
      // consumer for its `workflow.run.completed` event: the `WorkflowRun` row stayed `RUNNING`
      // and the consultation stayed `DRAINING` until the 24h sweep (16 consultations on
      // 2026-09-10). Guarded on its own: the run has ALREADY started here, so a watcher failure
      // must never be reported to the caller as a dispatch that did not happen.
      try {
        this.runCompletion?.watch(tenantId, runId, consultationId);
      } catch (error) {
        this.logger.warn({
          message: 'Consultation run started but its completion watcher could not be attached — the terminal status waits for a reader',
          consultationId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // record the decision AFTER the run has actually started. The
      // order is the safety argument: every failure up to this line degrades to
      // "Substrate A documents this consultation", never to "nobody does".
      const governanceRecorded = await this.recordGovernance(consultationId, runId, definition.slug);

      this.logger.log({
        message: 'Consultation governed by tenant-authored workflow',
        consultationId,
        runId,
        slug: definition.slug,
        source: resolved.source,
        governanceRecorded,
      });
      return { dispatched: true, source: resolved.source, workflowDefinitionSlug: definition.slug, runId, governanceRecorded, sttPipelineId };
    } catch (error) {
      // Best-effort BY DESIGN: a clinician must be able to open a consultation even when the
      // harness is down. The consultation proceeds under Substrate A and the reason is recorded.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn({ message: 'Consultation workflow dispatch failed — falling back to the default loop', consultationId, reason });
      return notDispatched(reason);
    }
  }

  /**
   * Persist the marker that makes Substrate A stand down for this consultation
   * Returns whether the decision is now durable.
   *
   * Best-effort in the sense that it never throws — the interpreter run has already
   * started by the time this runs, so raising here would report a dispatch that
   * demonstrably happened as a failure. It is NOT best-effort in the sense of being
   * ignorable: a `false` return means BOTH engines will write this consultation's
   * document, so it is logged at ERROR and surfaced on the result rather than
   * swallowed. (The window is narrow: `recordRunStarted` above is itself a DB write
   * on the same connection, so a database that answered it will almost always answer
   * this too.)
   */
  private async recordGovernance(consultationId: string, runId: string, workflowDefinitionSlug: string): Promise<boolean> {
    try {
      const consultation = await this.consultationRepository.findById(consultationId);
      if (!consultation) {
        this.logger.error({
          message: 'Substrate B started but the consultation row could not be loaded — BOTH engines may now write this document',
          consultationId,
          runId,
        });
        return false;
      }

      consultation.metadata = withGoverningEngineMarker(consultation.metadata, { workflowRunId: runId, workflowDefinitionSlug });
      await this.consultationRepository.update(consultationId, consultation);
      return true;
    } catch (error) {
      this.logger.error({
        message: 'Substrate B started but its governing-engine marker could not be persisted — BOTH engines may now write this document',
        consultationId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * completes the STT lane: assignment -> definition slug ->
   * compiled `AsrPipeline` id.
   *
   * The rest of this lane was already live. Publishing an `stt`-palette graph writes a REAL
   * `AsrPipeline` + `AsrPipelineVersion` through the production `PipelineService` ,
   * and that pipeline already shows up in the consultation Listener selector. The only unwired
   * link was this one — `SttPipelineResolverService` had no injector at all.
   *
   * Best-effort, exactly like the dispatch path above: a resolution failure returns `null` ("fall
   * back to the tenant's existing pipeline resolution"), never an exception, because nothing here
   * may stop a clinician opening a consultation.
   *
   * NOT done here: binding this id into the realtime WS session. That lives under
   * `apps/api/src/modules/streaming/**`, which grep-gate deliberately fences so a
   * change there forces an explicit decision rather than riding along in an unrelated diff.
   */
  private async resolveSttPipelineId(_tenantId: string, _departmentId: string | null): Promise<string | null> {
    // TASK-893: the `stt` palette is retired with the rest of the legacy vocabulary, so there is
    // no `stt` assignment to resolve and no graph that compiles to an `AsrPipeline`. The ASR
    // binding is the tenant's SPEECH_TO_TEXT Agent, resolved by the gateway at session start
    // (TASK-861 `ResolvedAsrSpec`); `sttPipelineId` stays on the result for wire compatibility and
    // is always `null`. Retargeting this read to the `core` palette would ask the pipeline
    // resolver for a pipeline no `core` graph compiles — a warning per consultation open, for
    // nothing.
    return null;
  }

  /**
   * TASK-891 — the reserved `visit-type:<key>` selector tag for the consultation-palette
   * cascade (OD-2/OD-3). `parentConsultationId` is threaded in by the caller rather than
   * re-read here (see `DispatchForConsultationInput.parentConsultationId`); an absent value
   * means "not a follow-up", so this never fails — it degrades to `visit-type:new-visit`,
   * exactly `VisitTypeService.forConsultation`'s own fallback for a consultation with no
   * recorded visit type and no parent link.
   *
   * Pure and synchronous: `VisitTypeService` holds no state and does no I/O (see its own
   * header — the tenant-managed catalogue it used to read was retired by TASK-882), so this
   * cannot change the best-effort failure profile of the caller above it.
   */
  private visitTypeSelectorTags(tenantId: string, parentConsultationId: string | null | undefined): string[] {
    const visitType = (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).forConsultation(tenantId, { isFollowUp: Boolean(parentConsultationId) });
    return [`visit-type:${visitType.key}`];
  }
}
