import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConsultationRepository, generateId, WorkflowDefinitionRepository } from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { IWorkflowAssignmentService } from '../../workflow-assignment/IWorkflowAssignmentService';
import { IWorkflowRunCompletionPort } from '../../workflow-run/IWorkflowRunCompletionPort';
import { IWorkflowRunService } from '../../workflow-run/IWorkflowRunService';
import { consultationDispatchSessionId } from '../../workflow-run/workflow-run.service';
import { RUN_ON_BEHALF_OF_KEY, RUN_STARTED_BY_KEY, RunPrincipalAccessService, type RunPrincipal } from '../../workflow-run/run-principal-access';
import { HarnessGatewayService } from '../harness/harness-gateway.service';
import { IS3Service } from '../../baseServices/storage/s3/IS3Service';
import { CLAIM_CHECK_BUCKET, mintCompiledConfigClaimCheckRef } from '../../workflow-exposure/claim-check';
import { effectiveTriggerConfig, triggerContextBinding } from '../../workflow-exposure/effective-trigger-schema';
import { EffectiveTriggerSchemaService } from '../../workflow-exposure/effective-trigger-schema.service';
import { type GoverningEngineMarker, readGoverningEngineMarker, withGoverningEngineMarker } from '../governing-engine';
import { DEFAULT_VISIT_TYPE_SERVICE, VisitTypeService } from '../visit-type/visit-type.service';
import { CORE_PALETTE_KEY } from '@arcaai/workflow-contract';
import { consultationSelectionViolation } from './consultation-selection-policy';
import { SelectableConsultationWorkflowListResponse } from './dto';
import {
  ConsultationWorkflowDispatchResult,
  DispatchForConsultationInput,
  GoverningWorkflowPreview,
  IConsultationWorkflowDispatchService,
  PreviewGoverningWorkflowInput,
  SupersedeGoverningRunInput,
  SupersedeGoverningRunResult,
} from './IConsultationWorkflowDispatchService';

/** TASK-1022 L-RESUME — the `WorkflowRun.trigger` of a run that re-finalises a resumed consultation. */
const CONSULTATION_RESUME_TRIGGER = 'consultation resume';
/** Compare-and-set attempts on the marker before a supersede gives up on a row other writers keep moving. */
const SUPERSEDE_CLAIM_ATTEMPTS = 3;

/**
 * Dispatches a tenant-authored `consultation`-palette workflow at consultation open,
 * and RECORDS that decision on the consultation so Substrate A stands down.
 * See `IConsultationWorkflowDispatchService` for why this is opt-in and exclusive.
 */
@Injectable()
export class ConsultationWorkflowDispatchService implements IConsultationWorkflowDispatchService {
  private readonly logger = new Logger(ConsultationWorkflowDispatchService.name);
  /** TASK-1022 L-RESUME — one supersede at a time per consultation, in this process. */
  private readonly supersedesInFlight = new Map<string, Promise<SupersedeGoverningRunResult>>();

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
    // Resolves the tenant's CURRENT schema pin for a trigger that binds by it, so the per-run
    // config below carries what the tenant has pinned NOW rather than what publish froze.
    // `@Optional()` like every other cross-cutting dependency here: absent, every trigger
    // dispatches against its published bytes — the behaviour a follow-latest workflow had
    // before this existed, never a failure.
    @Optional() private readonly effectiveTriggerSchema?: EffectiveTriggerSchemaService,
    // TASK-1038 OD-35 — a governed run is readable on the business plane, and every business-plane
    // run read is bound to the run's starter, so the row records it (`_metadata.startedBy`) like
    // the exposure plane's. From `WorkflowRunServiceModule` (imported here). `@Optional()` so the
    // positional fixtures keep constructing; absent, nothing is stamped (tenant-wide readers only).
    @Optional() private readonly runAccess?: RunPrincipalAccessService,
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
    const {
      consultationId,
      tenantId,
      departmentId,
      userId,
      externalPatientId,
      workflowDefinitionSlug,
      parentConsultationId,
      visitType,
      authoredContext,
    } = input;

    // point 5 — a caller selection REPLACES the consultation-palette cascade.
    // `assignments.resolve` is not called at all in that case: consulting it and then discarding
    // the answer would put a second, invisible slug in the logs for an operator to mistake for
    // the one that ran.
    const resolved: { workflowDefinitionSlug: string | null; source: ConsultationWorkflowDispatchResult['source'] } = workflowDefinitionSlug
      ? { workflowDefinitionSlug, source: 'caller-selected' }
      : await this.assignments.resolve(
          tenantId,
          CORE_PALETTE_KEY,
          departmentId ?? null,
          this.visitTypeSelectorTags(tenantId, parentConsultationId, visitType),
        );

    // No tier assigned anything -> Substrate A keeps the consultation. This is the DEFAULT and
    // must stay the default: a tenant that has authored nothing sees today's behaviour exactly.
    if (!resolved.workflowDefinitionSlug) {
      return { dispatched: false, source: resolved.source, workflowDefinitionSlug: null, runId: null, governanceRecorded: false };
    }

    const notDispatched = (skippedReason: string): ConsultationWorkflowDispatchResult => ({
      dispatched: false,
      source: resolved.source,
      workflowDefinitionSlug: resolved.workflowDefinitionSlug,
      runId: null,
      governanceRecorded: false,
      skippedReason,
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

      // The per-run config, and the ONE place a follow-latest trigger's promise is kept.
      //
      // `definition.compiledConfig` is the PUBLISHED artifact: immutable, checksummed, and
      // frozen against whatever the schema was when the workflow was published. For a trigger
      // the author PINNED that is the right answer forever. For one bound to the tenant's pin it
      // is stale the moment the tenant publishes a new schema version — and `interpreter_core_trigger`
      // validates `resolved` with `additionalProperties: false`, so a kind added since would fail
      // the run's first node. Resolving here, into the per-run copy, is what lets the interpreter
      // keep reading `resolved` and nothing else.
      const effective = await this.effectiveTriggerConfigFor(tenantId, definition.compiledConfig, definition.contextSchemaFollowsLatest);

      const configRef = await mintCompiledConfigClaimCheckRef(effective.config, CLAIM_CHECK_BUCKET, (b, key, data, contentType) =>
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
        // TASK-1038 E2 (fix 3) — the internal consultation-read route admits a run only when its
        // row names the consultation; governance is recorded AFTER the start, so without this the
        // run's first consultation read could be refused 404. Same stamp as the exposure plane.
        // OD-35 — and the principal that opened the consultation.
        metaData: withStartedBy({ consultationId }, this.runAccess?.currentPrincipal() ?? null, userId),
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
      await this.startOrFailRow(tenantId, sessionId, runId, {
        runId,
        sessionId,
        workflowVersionId: definition.id,
        tenantId,
        configRef,
        sandbox: false,
        subject: { consultationId, userId, externalPatientId: externalPatientId ?? undefined },
        // TASK-951 §D-6 — the client's own validated context, so `trigger.context.*` resolves to
        // something. Omitted entirely when there is none, which is byte-identical to before (the
        // gateway sends `payload: input.payload ?? {}`). It cannot forge identity: the dispatcher
        // strips every reserved identity key out of `payload` unconditionally and re-stamps them
        // from `subject` above.
        ...(authoredContext && Object.keys(authoredContext).length > 0 ? { payload: authoredContext } : {}),
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
      return { dispatched: true, source: resolved.source, workflowDefinitionSlug: definition.slug, runId, governanceRecorded };
    } catch (error) {
      // Best-effort BY DESIGN: a clinician must be able to open a consultation even when the
      // harness is down. The consultation proceeds under Substrate A and the reason is recorded.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn({ message: 'Consultation workflow dispatch failed — falling back to the default loop', consultationId, reason });
      return notDispatched(reason);
    }
  }

  /**
   * TASK-1022 L-RESUME — see `IConsultationWorkflowDispatchService.supersedeGoverningRun`.
   *
   * ## Why supersede, and not a signal to the parked run
   *
   * The parked run cannot re-finalise: `n_finalize` ran before its `core.humanReview`, and the
   * interpreter's signal surface is `cancel`-only by design. Teaching it to loop back would be
   * workflow code (a `workflow.patched` gate and a replay fixture). A FRESH run of the same graph
   * needs none: its live phase polls `readLiveHandoff`, which answers `ended: true` at once with the
   * handoff the resumed stop wrote (its record covers the whole visit — the live lane resumed from
   * the persisted sections), and its `n_finalize` → `persistDraft` ADOPTS the existing unsigned
   * `RAW_SUMMARY` in place (same summary id, a new version), moves the consultation to
   * `PENDING_REVIEW` and restarts the completion window.
   *
   * ## Order, and what each failure leaves behind
   *
   *   1. CLAIM the marker by compare-and-set, before anything starts. Two deliveries of one stop
   *      (or two instances) race here and exactly one wins; the loser re-reads, finds its own
   *      `supersedeTriggerId` and starts nothing.
   *   2. Anchor the `WorkflowRun` row and START the run. A failure puts the old marker back and
   *      leaves the parked run untouched — the consultation keeps its first note.
   *   3. Only then TERMINATE the parked run (its review child goes with it) and close its row
   *      (`CANCELED` if still running; a finished row keeps its status). Best-effort: a run that is already gone, or cannot be reached, costs nothing
   *      but a log line, because the marker already names the new run and every consultation
   *      surface (sign-off review release, completion stamping) follows the marker.
   */
  supersedeGoverningRun(input: SupersedeGoverningRunInput): Promise<SupersedeGoverningRunResult> {
    const previous = this.supersedesInFlight.get(input.consultationId);
    const run: Promise<SupersedeGoverningRunResult> = (previous ?? Promise.resolve())
      // swallow-ok: ordering only — `runSupersede` never rejects and logs its own failures.
      .catch(() => undefined)
      .then(() => this.runSupersede(input))
      .finally(() => {
        if (this.supersedesInFlight.get(input.consultationId) === run) this.supersedesInFlight.delete(input.consultationId);
      });
    this.supersedesInFlight.set(input.consultationId, run);
    return run;
  }

  private async runSupersede(input: SupersedeGoverningRunInput): Promise<SupersedeGoverningRunResult> {
    const { consultationId, tenantId, triggerId } = input;
    const failed = (reason: string, runId: string | null): SupersedeGoverningRunResult => {
      this.logger.error({
        message: 'Governed resume NOT re-finalised — the governing run could not be superseded; the note still covers only the earlier recordings',
        consultationId,
        runId,
        triggerId,
        reason,
      });
      return { superseded: false, runId, supersededRunId: null, skippedReason: 'failed', reason };
    };

    try {
      let consultation = await this.consultationRepository.findById(consultationId);
      if (!consultation) return failed('consultation not found', null);
      let marker = readGoverningEngineMarker(consultation.metadata);
      if (!marker) return { superseded: false, runId: null, supersededRunId: null, skippedReason: 'not-governed' };
      if (marker.supersedeTriggerId === triggerId) return this.duplicate(consultationId, triggerId, marker);

      // The version the parked run EXECUTED, not whatever is published now: a re-finalisation must
      // produce the note the same graph would have produced, not a different graph's.
      // OD-35 — with the run's starter: a resume re-finalises the SAME visit, so whoever followed
      // the governed run keeps following its successor.
      const { run: governing, startedBy: governingStartedBy } = this.runAccess
        ? await this.workflowRunService.getRunForReader(tenantId, marker.workflowRunId)
        : { run: await this.workflowRunService.getRun(tenantId, marker.workflowRunId), startedBy: null };
      const definition = await this.definitionRepository.findById(governing.workflowVersionId);
      if (!definition?.compiledConfig) return failed('the governing definition version has no compiled configuration', marker.workflowRunId);
      if (!this.s3Service) return failed('no claim-check storage backend is configured', marker.workflowRunId);

      const effective = await this.effectiveTriggerConfigFor(tenantId, definition.compiledConfig, definition.contextSchemaFollowsLatest);
      const configRef = await mintCompiledConfigClaimCheckRef(effective.config, CLAIM_CHECK_BUCKET, (b, key, data, contentType) =>
        this.s3Service!.putFile(b, key, data, contentType),
      );

      const runId = generateId();
      const sessionId = consultationDispatchSessionId(runId);

      // 1. CLAIM.
      let previousMarker: GoverningEngineMarker | null = null;
      for (let attempt = 0; attempt < SUPERSEDE_CLAIM_ATTEMPTS && previousMarker === null; attempt++) {
        if (attempt > 0) {
          consultation = await this.consultationRepository.findById(consultationId);
          marker = readGoverningEngineMarker(consultation?.metadata);
          if (!consultation || !marker) return failed('the governing marker disappeared while superseding', null);
          if (marker.supersedeTriggerId === triggerId) return this.duplicate(consultationId, triggerId, marker);
        }
        const expectedVersion = consultation.version;
        const claimed = marker;
        consultation.metadata = withGoverningEngineMarker(consultation.metadata, {
          workflowRunId: runId,
          workflowDefinitionSlug: definition.slug,
          supersededRunId: claimed.workflowRunId,
          supersedeTriggerId: triggerId,
        });
        try {
          await this.consultationRepository.updateWithVersion(consultationId, consultation, expectedVersion);
          previousMarker = claimed;
        } catch (error) {
          if (!(error instanceof OptimisticConcurrencyException)) throw error;
        }
      }
      if (!previousMarker) return failed('the consultation row kept changing — the governing marker could not be claimed', marker.workflowRunId);
      const supersededRunId = previousMarker.workflowRunId;

      // 2. START — the same anchor-then-start order as `dispatchForConsultation`.
      try {
        await this.workflowRunService.recordRunStarted({
          tenantId,
          workflowVersionId: definition.id,
          workflowSlug: definition.slug,
          workflowVersionNumber: definition.versionNumber,
          definitionName: definition.name,
          sessionId,
          runId,
          trigger: CONSULTATION_RESUME_TRIGGER,
          isSandbox: false,
          // TASK-1038 E2 (fix 3) — see `dispatchForConsultation`. OD-35 — the superseded run's
          // starter, else the principal triggering the resume.
          metaData: withStartedBy({ consultationId }, governingStartedBy ?? this.runAccess?.currentPrincipal() ?? null, consultation.doctorId ?? input.userId),
        });
        await this.startOrFailRow(tenantId, sessionId, runId, {
          runId,
          sessionId,
          workflowVersionId: definition.id,
          tenantId,
          configRef,
          sandbox: false,
          subject: {
            consultationId,
            userId: consultation.doctorId ?? input.userId ?? undefined,
            externalPatientId: consultation.patientId ?? undefined,
          },
          ...(input.authoredContext && Object.keys(input.authoredContext).length > 0 ? { payload: input.authoredContext } : {}),
          ...(input.guardrailOverrideNoticeIds?.length ? { guardrailOverrideNoticeIds: input.guardrailOverrideNoticeIds } : {}),
        });
      } catch (error) {
        await this.restoreMarker(consultationId, runId, previousMarker);
        return failed(error instanceof Error ? error.message : String(error), supersededRunId);
      }

      try {
        this.runCompletion?.watch(tenantId, runId, consultationId);
      } catch (error) {
        this.logger.warn({
          message: 'Superseding run started but its completion watcher could not be attached — the terminal status waits for a reader',
          consultationId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // 3. RETIRE the parked run.
      await this.retireSupersededRun(tenantId, consultationId, supersededRunId, runId);

      this.logger.log({
        message: 'Governed resume — the governing run was superseded; the new run re-finalises the whole visit',
        consultationId,
        runId,
        supersededRunId,
        triggerId,
        slug: definition.slug,
        workflowVersionId: definition.id,
      });
      return { superseded: true, runId, supersededRunId };
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error), null);
    }
  }

  /**
   * Start the run whose `WorkflowRun` row was just anchored. A start that throws must not leave that
   * row RUNNING forever: it is closed FAILED with a code only (the error's message is never
   * persisted) — best-effort — and the start error is rethrown to the caller's existing handling.
   */
  private async startOrFailRow(
    tenantId: string,
    sessionId: string,
    runId: string,
    input: Parameters<HarnessGatewayService['startWorkflowRun']>[0],
  ): Promise<void> {
    try {
      await this.harnessGateway.startWorkflowRun(input);
    } catch (error) {
      try {
        await this.workflowRunService.recordRunFinished({ tenantId, sessionId, runId, status: 'FAILED', firstErrorCode: 'RUN_START_FAILED' });
      } catch {
        // swallow-ok: the start error below is the one the caller must see.
      }
      throw error;
    }
  }

  private duplicate(consultationId: string, triggerId: string, marker: GoverningEngineMarker): SupersedeGoverningRunResult {
    this.logger.log({
      message: 'Governed resume already re-finalised for this recording — nothing started',
      consultationId,
      triggerId,
      runId: marker.workflowRunId,
    });
    return { superseded: false, runId: marker.workflowRunId, supersededRunId: marker.supersededRunId ?? null, skippedReason: 'duplicate' };
  }

  /** Put the marker back after a start that failed — only if it still names the run that never started. */
  private async restoreMarker(consultationId: string, runId: string, previous: GoverningEngineMarker): Promise<void> {
    try {
      const consultation = await this.consultationRepository.findById(consultationId);
      if (!consultation || readGoverningEngineMarker(consultation.metadata)?.workflowRunId !== runId) return;
      const expectedVersion = consultation.version;
      const metadata = { ...(consultation.metadata as Record<string, unknown>) };
      // Rebuilt from the previous marker ALONE, so the claim's provenance fields do not survive it.
      delete metadata.governingEngine;
      consultation.metadata = withGoverningEngineMarker(metadata, previous);
      await this.consultationRepository.updateWithVersion(consultationId, consultation, expectedVersion);
    } catch (error) {
      this.logger.error({
        message: 'Superseding run failed to start AND the governing marker could not be restored — the marker names a run that never started',
        consultationId,
        runId,
        previousRunId: previous.workflowRunId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Terminate the parked run (and its review child) and close its row. Best-effort, both halves.
   *
   * TASK-1022 A2 — the row is closed through `recordRunSuperseded`, never `recordRunFinished`: the
   * run being superseded may already have FINISHED on its own (COMPLETED at `n_finalize`, then
   * closed), and its terminal status and `endedAt` are facts the supersede must not rewrite. Only a
   * row still RUNNING becomes CANCELED; every row gets `_metadata.supersededBy`.
   */
  private async retireSupersededRun(tenantId: string, consultationId: string, supersededRunId: string, runId: string): Promise<void> {
    const reason = `superseded by ${runId} (resumed recording re-finalised by the governing graph)`;
    try {
      // An already-closed run resolves with `alreadyClosed: true` (logged at info by the gateway).
      await this.harnessGateway.terminateWorkflowRun(supersededRunId, { tenantId, reason });
    } catch (error) {
      this.logger.warn({
        message: 'Superseded governing run could not be terminated (harness unreachable or failed) — the marker already names the new run',
        consultationId,
        supersededRunId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await this.workflowRunService.recordRunSuperseded({
        tenantId,
        sessionId: consultationDispatchSessionId(supersededRunId),
        runId: supersededRunId,
        supersededBy: runId,
        terminalReason: reason,
        consultationId,
      });
    } catch (error) {
      this.logger.warn({
        message: 'Superseded governing run row could not be closed (CANCELED if still running, provenance otherwise)',
        consultationId,
        supersededRunId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The same resolution dispatch performs, WITHOUT starting anything: which workflow would
   * govern a consultation opened right now, and which payload schema its trigger would check.
   *
   * This exists so `open` can refuse an incompatible context BEFORE it writes a row, and it is a
   * method on this service rather than a second cascade at the call site for one reason: a
   * preview that disagreed with the dispatch that follows it would be worse than no preview.
   * Every step below — the selection-over-cascade precedence, the visit-type selector tag, the
   * published-and-selectable re-check, the effective trigger schema — is the code dispatch runs.
   *
   * Returns `null` for EVERY inconclusive outcome, never an exception: no assignment, a
   * definition that has since been unpublished, a missing compiled config, a trigger that froze
   * no schema, or an unreadable dependency. The caller's contract is that only a CONCLUSIVE
   * answer may refuse an open; anything else falls through to today's ungoverned open.
   */
  async previewGoverningWorkflow(input: PreviewGoverningWorkflowInput): Promise<GoverningWorkflowPreview | null> {
    try {
      const slug =
        input.workflowDefinitionSlug ??
        (
          await this.assignments.resolve(
            input.tenantId,
            CORE_PALETTE_KEY,
            input.departmentId ?? null,
            this.visitTypeSelectorTags(input.tenantId, input.parentConsultationId, input.visitType),
          )
        ).workflowDefinitionSlug;
      if (!slug) return null;

      const definition = await this.definitionRepository.findPublishedBySlug(input.tenantId, slug);
      if (!definition || consultationSelectionViolation(definition) !== null || !definition.compiledConfig) return null;

      const effective = await this.effectiveTriggerConfigFor(input.tenantId, definition.compiledConfig, definition.contextSchemaFollowsLatest);
      if (effective.resolved === null) return null;

      return {
        workflowDefinitionSlug: definition.slug,
        resolved: effective.resolved,
        boundSchemaVersion: effective.effectiveVersionNumber ?? this.publishedSchemaVersion(definition.compiledConfig),
      };
    } catch (error) {
      this.logger.warn({
        message: 'Governing workflow could not be previewed — the consultation opens without a pre-dispatch compatibility check',
        tenantId: input.tenantId,
        departmentId: input.departmentId ?? null,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * The config a run started NOW executes against.
   *
   * Never throws and never blocks: an unwired resolver, an unreadable schema row or a withdrawn
   * pin all answer with the published bytes, because dispatch is best-effort by contract and a
   * clinician must be able to open a consultation whatever the schema plane is doing.
   */
  private async effectiveTriggerConfigFor(
    tenantId: string,
    compiledConfig: unknown,
    followsLatestHint?: boolean | null,
  ): Promise<ReturnType<typeof effectiveTriggerConfig>> {
    const binding = triggerContextBinding(compiledConfig, followsLatestHint);
    if (!binding.followsLatest || binding.schemaId === null || !this.effectiveTriggerSchema) {
      return effectiveTriggerConfig(compiledConfig, null, followsLatestHint);
    }
    return effectiveTriggerConfig(compiledConfig, await this.effectiveTriggerSchema.currentPin(tenantId, binding.schemaId), followsLatestHint);
  }

  /**
   * The schema version a PINNED trigger's frozen bytes came from, read off the compiled
   * artifact's own `contextSchemaRefs` entry. `null` when the artifact records none — the
   * refusal still names the workflow, which is the part an integrator acts on.
   */
  private publishedSchemaVersion(compiledConfig: unknown): number | null {
    const policyBindings =
      typeof compiledConfig === 'object' && compiledConfig !== null ? (compiledConfig as Record<string, unknown>).policyBindings : undefined;
    const refs =
      typeof policyBindings === 'object' && policyBindings !== null ? (policyBindings as Record<string, unknown>).contextSchemaRefs : undefined;
    const first = Array.isArray(refs) ? refs[0] : undefined;
    const versionNumber = typeof first === 'object' && first !== null ? (first as Record<string, unknown>).versionNumber : undefined;
    return typeof versionNumber === 'number' ? versionNumber : null;
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
   * TASK-891 — the reserved `visit-type:<key>` selector tag for the consultation-palette
   * cascade (OD-2/OD-3). `parentConsultationId` is threaded in by the caller rather than
   * re-read here (see `DispatchForConsultationInput.parentConsultationId`); an absent value
   * means "not a follow-up", so this never fails — it degrades to `visit-type:new-visit`,
   * exactly `VisitTypeService.forConsultation`'s own fallback for a consultation with no
   * recorded visit type and no parent link.
   *
   * TASK-951 §D-3 — `recorded` is that missing half, now that a caller can STATE its visit type
   * through the tenant's context schema. `forConsultation` ranks it above the parent link, so a
   * stated value selects the assignment; absent, the derivation is byte-identical to before.
   *
   * Pure and synchronous: `VisitTypeService` holds no state and does no I/O (see its own
   * header — the tenant-managed catalogue it used to read was retired by TASK-882), so this
   * cannot change the best-effort failure profile of the caller above it.
   */
  private visitTypeSelectorTags(tenantId: string, parentConsultationId: string | null | undefined, recorded?: string | null): string[] {
    const visitType = (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).forConsultation(tenantId, {
      recorded,
      isFollowUp: Boolean(parentConsultationId),
    });
    return [`visit-type:${visitType.key}`];
  }
}

/**
 * TASK-1038 OD-35 — `metaData` plus `startedBy` when a starter is known, plus (owner follow-up,
 * 2026-10-05) `onBehalfOf` = the consultation's clinician, so a doctor reads a governed run a
 * machine opened for them. Each key is written only when known.
 */
function withStartedBy(metaData: Record<string, unknown>, startedBy: RunPrincipal | null, clinicianUserId?: string | null): Record<string, unknown> {
  return {
    ...metaData,
    ...(startedBy ? { [RUN_STARTED_BY_KEY]: startedBy } : {}),
    ...(clinicianUserId ? { [RUN_ON_BEHALF_OF_KEY]: { type: 'user', id: clinicianUserId } satisfies RunPrincipal } : {}),
  };
}
