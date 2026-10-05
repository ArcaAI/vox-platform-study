import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { ResourceType, SysEventType, WorkflowRunEntity, WorkflowRunFactory, WorkflowRunKind, WorkflowRunRepository, WorkflowRunStatus } from '@arcaai/domains';
import { BaseService } from '../../common';
import { buildCursorFindAllProps, clampCursorLimit, CursorPage, decodeCursor, MAX_CURSOR_LIMIT, toCursorPage } from '../../common/cursorPagination';
import { IActiveUserContext } from '../../interfaces';
import { AgentTrajectoryStepResponse, IAgentTrajectoryService } from '../agent-trajectory';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { HarnessGatewayService } from '../consultation/harness/harness-gateway.service';
import {
  ApproveRunGateInput,
  GetRunTraceOptions,
  ListWorkflowRunsFilters,
  ListWorkflowRunsOptions,
  RecordRunFinishedInput,
  RecordRunStartedInput,
  RecordRunSupersededInput,
  RunNodeRollupResponse,
  RunGateStateResponse,
  RunTraceResponse,
  WorkflowRunResponse,
} from './dto';
import { IWorkflowRunService } from './IWorkflowRunService';
import { readRunOnBehalfOf, readRunStartedBy, type RunPrincipal } from './run-principal-access';
import { WorkflowRunDtoMapper } from './workflow-run.dto.mapper';

/**
 * Mirrors `interpreter_workflow_id()` (apps/harness/.../interpreter/workflow.py:52-58) — see the
 * Task 1 contract
 * for exactly why `sessionId` — not the trajectory row's own `runId` column — is the correct
 * join key onto `AgentTrajectoryStep`.
 */
export const INTERPRETER_WORKFLOW_ID_PREFIX = 'workflow-interpreter-';

/** `recordRunSuperseded` re-reads after an OCC conflict at most this many times in total. */
const SUPERSEDE_WRITE_ATTEMPTS = 3;
/** TASK-1038 E2 (fix 5) — `recordRunFinished` re-reads after an OCC conflict at most this many times in total. */
const RECORD_FINISHED_WRITE_ATTEMPTS = 3;

export function interpreterSessionId(runId: string): string {
  return `${INTERPRETER_WORKFLOW_ID_PREFIX}${runId}`;
}

/**
 * The session key `ConsultationWorkflowDispatchService` anchors a CONSULTATION-governed run
 * with (`wf-<runId>`). It is not the exposure plane's key above, and until the lookup below
 * accepted both, every run a consultation started answered 404 on
 * `workflows/{slug}/runs/{runId}/…` — the same row, unreachable by convention (TASK-933 H3-5).
 * Declared here, next to its sibling, so the two can no longer drift apart in silence.
 */
/**
 * The 404 an unknown or cross-tenant run id answers with — and, under TASK-1038 OD-35, the SAME
 * 404 a run another principal started answers with, so the two can never be told apart.
 */
export function workflowRunNotFound(runId: string): NotFoundException {
  return new NotFoundException(`WorkflowRun ${runId} not found`);
}

export const CONSULTATION_DISPATCH_SESSION_PREFIX = 'wf-';
export function consultationDispatchSessionId(runId: string): string {
  return `${CONSULTATION_DISPATCH_SESSION_PREFIX}${runId}`;
}

/**
 * Mirrors `AgentTrajectoryRetentionService`'s own AppSettings keys/defaults
 * exactly (`agentic.trajectory.{enabled,retentionDays}`) — this is the SAME
 * cascade the retention cron reads, not a second copy of the decision
 * (Task 10 retention note; README pitfall 3 / Task 9's "trace pruned" state).
 */
const TRAJECTORY_RETENTION_ENABLED_KEY = 'agentic.trajectory.enabled';
const TRAJECTORY_RETENTION_DAYS_KEY = 'agentic.trajectory.retentionDays';
const TRAJECTORY_RETENTION_DAYS_DEFAULT = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * TASK-950 (decision 2, fast win) — put the caller's bookkeeping into the `_metadata` column of a
 * run row that has just been built and not yet persisted.
 *
 * ## Why this reaches past the entity's public surface
 *
 * `WorkflowRunEntity` exposes NO `metaData` accessor. `IBaseEntity.metaData` is declared but was
 * never wired on `BaseEntity` (no backing field, no getter, no setter), and unlike `AiModelEntity`
 * — which declares its own `_metaData` precisely because of that gap — this entity never added
 * one. So the entity header's claim that `_metadata` "round-trips through the shared
 * BaseTenantEntity / Repository machinery" is true of the COLUMN and of the Prisma MODEL
 * (`BaseDataModel.metaData`), but not of the entity in between.
 *
 * `WorkflowRunEntityMapper.toPersistence` maps the entity's own enumerable fields via
 * `toObject()`, which strips one leading underscore — so writing the backing field here is what
 * puts the value on the CREATE payload, and it is the only way to do so without changing
 * `packages/domains`. `setProperty` is not used (it is `protected`, and this runs before the row
 * exists, so there is no change to track).
 *
 * ## The half this does NOT buy, stated plainly
 *
 * `toDomainEntity` drops the column again on the way back, so nothing can READ this through the
 * entity, the repository, or `WorkflowRunResponse`. It is queryable in SQL
 * (`_metadata->>'actingUserId'`) and that is the "durable, queryable half" the ticket asked for.
 * Surfacing it on `WorkflowRunStatusResponse` needs the field promoted properly first —
 * `_metaData` + getter/setter on `WorkflowRunEntity`, `metaData?` on `WorkflowRunFactory`, then
 * `metaData` on `WorkflowRunResponse` + its DTO mapper.
 */
function stampRunMetaData(entity: WorkflowRunEntity, metaData: Record<string, unknown> | undefined): void {
  if (!metaData || Object.keys(metaData).length === 0) return;
  (entity as unknown as { _metaData?: Record<string, unknown> })._metaData = metaData;
}

function buildDateRange(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;
  const range: { gte?: Date; lte?: Date } = {};
  if (from) range.gte = new Date(from);
  if (to) range.lte = new Date(to);
  return range;
}

/**
 * Fold an ordered (`seq asc`) trajectory-step page into per-node rollups.
 *
 * A consecutive run of steps sharing the same `name` (the node TYPE — see
 * `RunNodeRollupResponse`'s class doc for why this is not a per-node id) is
 * folded into ONE group, labelled a DERIVED retry grouping (README pitfall 4
 * / Task 1 contract — no attempt column exists anywhere). A non-consecutive
 * repeat of the same `name` (a different node instance of the same type,
 * elsewhere in the run) starts a NEW group instead of merging — the closest
 * approximation of node identity available without a stamped node id.
 */
export function foldStepsIntoNodeRollups(steps: AgentTrajectoryStepResponse[]): RunNodeRollupResponse[] {
  const groups: RunNodeRollupResponse[] = [];
  for (const step of steps) {
    const previous = groups[groups.length - 1];
    if (previous && previous.nodeType === step.name) {
      previous.status = step.status;
      previous.endedAt = step.endedAt;
      previous.durationMs = step.durationMs;
      previous.errorCode = step.errorCode;
      previous.attemptSeqs.push(step.seq);
      previous.attemptCount += 1;
      continue;
    }
    const group = new RunNodeRollupResponse();
    group.nodeType = step.name;
    group.order = groups.length;
    group.status = step.status;
    group.startedAt = step.startedAt;
    group.endedAt = step.endedAt;
    group.durationMs = step.durationMs;
    group.errorCode = step.errorCode;
    group.attemptSeqs = [step.seq];
    group.attemptCount = 1;
    group.attemptGroupingIsDerived = true;
    groups.push(group);
  }
  return groups;
}

/**
 * WorkflowRunService — the runs/observability read model. D6's
 * "CQRS-lite ... read models for runs/observability".
 *
 * INTENTIONAL posture (mirrors AgentTrajectoryService, its sibling telemetry
 * service):
 *   - NO sys-event on write — a run row is a telemetry fact, same exemption
 *     as AgentTrajectoryStep (see WorkflowRunEntity header).
 *   - `recordRunStarted`/`recordRunFinished` are IDEMPOTENT on
 * `(tenantId, sessionId, runId)` — the write contract
 *     dispatcher (or a future gateway controller) calls. As of this ticket
 * nothing calls them yet (Task 1 contract / README R2).
 *   - `getRunTrace` issues exactly ONE bounded `IAgentTrajectoryService.listSteps`
 *     read per run — never a per-node query — reusing the trajectory
 *     service so PHI/`payloadRef` handling stays in one place (README Task 5).
 */
@Injectable()
export class WorkflowRunService extends BaseService implements IWorkflowRunService {
  private readonly logger = new Logger(WorkflowRunService.name);

  constructor(
    private readonly workflowRunRepository: WorkflowRunRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional so unit fixtures can construct without it; production DI
    // (AgentTrajectoryServiceModule) always supplies it.
    @Optional() @Inject(IAgentTrajectoryService) private readonly agentTrajectoryService?: IAgentTrajectoryService,
    // Optional for the same reason — `CommonServiceModule` always supplies it
    // in production. Used ONLY to compute `tracePruned` from the SAME
    // `agentic.trajectory.*` keys the retention cron reads (never a second
    // source of truth for the window).
    @Optional() @Inject(IAppSettingsService) private readonly appSettingsService?: IAppSettingsService,
    // Optional for the same reason. The gate's LIVE state is deliberately not in the read
    // model — see `IWorkflowRunService.getRunGate`.
    @Optional() private readonly harnessGatewayService?: HarnessGatewayService,
  ) {
    // Telemetry exemption — never broadcasts, so the ResourceType is inert
    // (same placeholder-constructor posture as AgentTrajectoryService).
    super(eventEmitter, clsService, ResourceType.WorkflowDefinition);
  }

  async listRuns(
    tenantId: string,
    filters: ListWorkflowRunsFilters = {},
    options: ListWorkflowRunsOptions = {},
  ): Promise<CursorPage<WorkflowRunResponse>> {
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    if (options.cursor && !cursor) {
      throw new BadRequestException('Invalid workflow-run cursor');
    }
    const limit = clampCursorLimit(options.limit);

    // TASK-1038 OD-26 — the table also holds AGENT runs (`POST /agents/:slug/runs`); this is the
    // WORKFLOW runs list, so they never appear in it.
    const where: Record<string, unknown> = { tenantId, kind: WorkflowRunKind.WORKFLOW };
    if (filters.workflowSlug) where.workflowSlug = filters.workflowSlug;
    if (filters.workflowVersionId) where.workflowVersionId = filters.workflowVersionId;
    if (filters.status) where.status = filters.status;
    if (filters.trigger) where.trigger = filters.trigger;
    // Single query-level filter point (Task 1 contract — sandbox runs are
    // excluded unless explicitly requested.
    if (!filters.includeSandbox) where.isSandbox = false;
    const startedAt = buildDateRange(filters.from, filters.to);
    if (startedAt) where.startedAt = startedAt;

    const props = buildCursorFindAllProps(cursor, limit, { where, sortKey: 'startedAt', direction: 'desc' });
    const rows = await this.workflowRunRepository.findAll(props);
    const paged = toCursorPage(rows, limit, (row) => row.startedAt.toISOString());

    return {
      data: paged.data.map(WorkflowRunDtoMapper.toResponse),
      nextCursor: paged.nextCursor,
      hasMore: paged.hasMore,
      limit: paged.limit,
    };
  }

  async getRun(tenantId: string, runId: string): Promise<WorkflowRunResponse> {
    const entity = await this.findRunOrThrow(tenantId, runId);
    return WorkflowRunDtoMapper.toResponse(entity);
  }

  async getRunForReader(tenantId: string, runId: string): Promise<{ run: WorkflowRunResponse; startedBy: RunPrincipal | null; onBehalfOf: RunPrincipal | null }> {
    const entity = await this.findRunOrThrow(tenantId, runId);
    return { run: WorkflowRunDtoMapper.toResponse(entity), startedBy: readRunStartedBy(entity.metaData), onBehalfOf: readRunOnBehalfOf(entity.metaData) };
  }

  async getRunRequestBodyHash(tenantId: string, runId: string): Promise<string | null> {
    const entity = await this.findRunOrThrow(tenantId, runId);
    const hash = entity.metaData?.requestBodyHash;
    return typeof hash === 'string' && hash.length > 0 ? hash : null;
  }

  async getRunGate(tenantId: string, runId: string): Promise<RunGateStateResponse> {
    // Tenancy FIRST, before anything is asked of the harness: a cross-tenant run id must 404
    // here, not leak the existence of another tenant's gate through a downstream error.
    await this.findRunOrThrow(tenantId, runId);

    if (!this.harnessGatewayService) {
      throw new ServiceUnavailableException('Harness gateway is not configured');
    }

    try {
      const state = await this.harnessGatewayService.getWorkflowRunGate(runId);
      return new RunGateStateResponse({
        runId,
        exists: state.exists,
        waiting: state.waiting,
        phase: state.phase,
        escalations: state.escalations,
        approved: state.approved,
      });
    } catch (error) {
      // A harness outage must not read as "no gate here" — that would silently hide a run
      // genuinely waiting on a clinician. Surface it.
      this.logger.warn({ message: 'Harness gate state read failed', runId, error: (error as Error)?.message });
      throw new ServiceUnavailableException('Could not read the gate state for this run');
    }
  }

  async approveRunGate(tenantId: string, runId: string, input: ApproveRunGateInput): Promise<RunGateStateResponse> {
    await this.findRunOrThrow(tenantId, runId);

    if (!this.harnessGatewayService) {
      throw new ServiceUnavailableException('Harness gateway is not configured');
    }

    // The signer is the ACTING user, resolved here — never a field a caller can set. A body
    // that could name the clinician is the forgery shape `03-compliance-posture.md` §3 forbids,
    // which is why `ApproveRunGateInput` has no such field to read.
    const clinicianId = this.requestUserId;
    if (!clinicianId) {
      throw new BadRequestException('No acting user to record as the approving clinician');
    }

    // Refuse to "approve" something that is not waiting. Signalling a decided or absent gate
    // would return success while reaching nothing — the caller must not be told a note was
    // signed when it was not.
    const before = await this.getRunGate(tenantId, runId);
    if (!before.exists) {
      throw new BadRequestException('This run has no human-approval gate');
    }
    if (!before.waiting) {
      throw new BadRequestException(`This run's gate is not waiting for a decision (phase: ${before.phase ?? 'unknown'})`);
    }

    await this.harnessGatewayService.approveWorkflowRunGate(runId, {
      decision: input.decision ?? 'SIGNED',
      clinicianId,
      contextItemVersionId: input.contextItemVersionId,
      attestationHash: input.attestationHash,
      tenantId,
    });

    this.logger.log({ message: 'Workflow run gate approved', runId, tenantId, clinicianId, decision: input.decision ?? 'SIGNED' });
    return this.getRunGate(tenantId, runId);
  }

  async getRunTrace(tenantId: string, runId: string, options: GetRunTraceOptions = {}): Promise<RunTraceResponse> {
    const entity = await this.findRunOrThrow(tenantId, runId);
    const maxSteps = options.maxSteps ?? MAX_CURSOR_LIMIT;

    if (!this.agentTrajectoryService) {
      // No trajectory reader wired (unit fixture without it) — never render a
      // silent empty timeline; fall through to the same pruned-state check a
      // real zero-step run would get.
      return {
        run: WorkflowRunDtoMapper.toResponse(entity),
        nodes: [],
        stepCount: 0,
        truncated: false,
        tracePruned: this.computeTracePruned(entity.startedAt, 0),
      };
    }

    // ONE bounded trajectory read per run — no per-node query (README
    // acceptance criteria / R8's hard cap).
    const page = await this.agentTrajectoryService.listSteps(tenantId, entity.sessionId, { limit: maxSteps });
    const steps = page.items;
    const nodes = foldStepsIntoNodeRollups(steps);

    return {
      run: WorkflowRunDtoMapper.toResponse(entity),
      nodes,
      stepCount: steps.length,
      truncated: page.hasMore,
      tracePruned: this.computeTracePruned(entity.startedAt, steps.length),
    };
  }

  /**
   * Task 9's "trace pruned" state: true only when the run genuinely has zero
   * steps AND its start predates the EFFECTIVE trajectory-retention window —
   * reading the identical `agentic.trajectory.{enabled,retentionDays}`
   * AppSettings keys `AgentTrajectoryRetentionService` reads (never a second,
   * possibly-drifted copy of the window). When retention is disabled
   * (`agentic.trajectory.enabled` default false, README R5) nothing is
   * actually pruned yet, so a zero-step run there is honestly "no steps
   * recorded" rather than "pruned" — this deliberately returns `false`, not a
   * guess. No settings service wired (unit fixture) ⇒ cannot tell either way
   * ⇒ `false`, never a false positive.
   */
  private computeTracePruned(startedAt: Date, stepCount: number): boolean {
    if (stepCount > 0) return false;
    if (!this.appSettingsService) return false;
    const enabled = this.appSettingsService.getValueWithDefault<boolean>(TRAJECTORY_RETENTION_ENABLED_KEY, false);
    if (!enabled) return false;
    const retentionDays = this.appSettingsService.getValueWithDefault<number>(TRAJECTORY_RETENTION_DAYS_KEY, TRAJECTORY_RETENTION_DAYS_DEFAULT);
    if (retentionDays < 1) return false;
    const cutoff = Date.now() - retentionDays * ONE_DAY_MS;
    return startedAt.getTime() < cutoff;
  }

  async recordRunStarted(input: RecordRunStartedInput): Promise<WorkflowRunResponse> {
    const runId = input.runId ?? '';
    const existing = await this.workflowRunRepository.findByRunKey(input.tenantId, input.sessionId, runId);
    if (existing) {
      // Idempotent on (tenantId, sessionId, runId) — a re-delivered start no-ops.
      return WorkflowRunDtoMapper.toResponse(existing);
    }

    const entity = WorkflowRunFactory.CreateRun({
      tenantId: input.tenantId,
      workflowVersionId: input.workflowVersionId,
      workflowSlug: input.workflowSlug,
      workflowVersionNumber: input.workflowVersionNumber,
      definitionName: input.definitionName,
      sessionId: input.sessionId,
      runId,
      trigger: input.trigger,
      isSandbox: input.isSandbox ?? false,
      startedAt: input.startedAt ?? new Date(),
    });
    stampRunMetaData(entity, input.metaData);
    const saved = await this.workflowRunRepository.create(entity);
    // NO sys-event — telemetry exemption (see WorkflowRunEntity header).
    return WorkflowRunDtoMapper.toResponse(saved);
  }

  async recordRunFinished(input: RecordRunFinishedInput): Promise<WorkflowRunResponse> {
    const runId = input.runId ?? '';
    const endedAt = input.endedAt ?? new Date();
    // TASK-1038 E2 (fix 5) — two writers close a run: the status sync (usually no result) and the
    // completion watcher (with the result). Both read `_version` N; the loser's write used to throw
    // and its result was lost. A conflict now re-reads and re-applies, a bounded number of times.
    let saved: WorkflowRunEntity | undefined;
    for (let attempt = 0; saved === undefined; attempt++) {
      // TASK-946 D3 — the SAME two-spelling lookup `findRunOrThrow` has done since TASK-933 H3-5.
      // The caller's `sessionId` is tried first (it is right for every exposure-plane run), then
      // both conventional keys: a consultation-dispatched run is anchored as `wf-<runId>`, so a
      // watcher that named the interpreter key 404'd against a row that exists — which is why the
      // 2026-09-10 consultation runs stayed `RUNNING` after their workflows had already FAILED.
      const entity =
        (await this.workflowRunRepository.findByRunKey(input.tenantId, input.sessionId, runId)) ??
        (await this.findRunByConventionalSessionKeys(input.tenantId, runId));
      if (!entity) {
        throw new NotFoundException(`WorkflowRun for run ${input.runId} not found`);
      }

      entity.status = input.status as WorkflowRunStatus;
      entity.endedAt = endedAt;
      entity.durationMs = Math.max(0, endedAt.getTime() - entity.startedAt.getTime());
      if (input.nodeCount !== undefined) entity.nodeCount = input.nodeCount;
      if (input.failedNodeCount !== undefined) entity.failedNodeCount = input.failedNodeCount;
      if (input.degradedNodeCount !== undefined) entity.degradedNodeCount = input.degradedNodeCount;
      // TASK-982 — no `skippedNodeCount` column; merged into the existing `_metadata` bag so
      // `actingUserId` (written by `recordRunStarted`) is never clobbered by this later write.
      if (input.skippedNodeCount !== undefined) {
        entity.metaData = { ...(entity.metaData ?? {}), skippedNodeCount: input.skippedNodeCount };
      }
      if (input.firstErrorCode !== undefined) entity.firstErrorCode = input.firstErrorCode;
      // A failed run always says why: a writer with no code (the completion watcher on a path
      // that carried none) gets the generic code of its status, and never clears a real one.
      if (!entity.firstErrorCode && (input.status === 'FAILED' || input.status === 'TIMED_OUT')) {
        entity.firstErrorCode = input.status === 'TIMED_OUT' ? 'RUN_TIMED_OUT' : 'RUN_FAILED';
      }
      // (M-2). `undefined` means the caller reported no delivered output (a graph with no
      // `output.deliver` node) and must leave any existing value alone. TASK-1038 E2 (fix 5): an
      // explicit `null` no longer clears a result already persisted — a writer that has no result
      // is never the authority over one that does.
      if (input.resultRef !== undefined && (input.resultRef !== null || entity.resultRef === null || entity.resultRef === undefined)) {
        entity.resultRef = input.resultRef as never;
      }

      if (!entity.hasChanges) {
        return WorkflowRunDtoMapper.toResponse(entity);
      }
      try {
        saved = await this.workflowRunRepository.updateWithVersion(entity.id, entity, entity.version);
      } catch (error) {
        if (!(error instanceof OptimisticConcurrencyException) || attempt >= RECORD_FINISHED_WRITE_ATTEMPTS - 1) throw error;
      }
    }

    // TASK-864 (owner decision D-5) — the ONE sys-event the run read model emits, on TERMINAL
    // status, so a `WorkflowRun` webhook subscription fires (`workflow.run.completed`). The
    // payload is PHI-FREE by construction: identifiers, status, reason and timestamps — never the
    // result, never a payload. The outbound delivery is reference-not-content anyway
    // (`webhook-delivery.processor.ts`), and this is the second layer of that rule.
    // `recordRunStarted` still emits nothing; `resourceType` is set explicitly so this service's
    // other events (gate approvals, on the definition) are unaffected.
    this.broadcastRunFinished(saved, input.tenantId, endedAt, input.terminalReason ?? null, input.consultationId ?? null);
    return WorkflowRunDtoMapper.toResponse(saved);
  }

  async recordRunSuperseded(input: RecordRunSupersededInput): Promise<WorkflowRunResponse> {
    for (let attempt = 0; ; attempt++) {
      const entity =
        (await this.workflowRunRepository.findByRunKey(input.tenantId, input.sessionId, input.runId)) ??
        (await this.findRunByConventionalSessionKeys(input.tenantId, input.runId));
      if (!entity) {
        throw new NotFoundException(`WorkflowRun for run ${input.runId} not found`);
      }

      // Only a row the run has not closed yet is the supersede's to close. A terminal row's status
      // and `endedAt` are what actually happened (e.g. COMPLETED before the resume) and stay.
      const cancelling = entity.status === WorkflowRunStatus.RUNNING;
      const endedAt = new Date();
      if (cancelling) {
        entity.status = WorkflowRunStatus.CANCELED;
        entity.endedAt = endedAt;
        entity.durationMs = Math.max(0, endedAt.getTime() - entity.startedAt.getTime());
      }
      // Merged, like `skippedNodeCount`, so `actingUserId` and the rest of the bag survive.
      if (entity.metaData?.supersededBy !== input.supersededBy) {
        entity.metaData = { ...(entity.metaData ?? {}), supersededBy: input.supersededBy };
      }
      if (!entity.hasChanges) {
        return WorkflowRunDtoMapper.toResponse(entity);
      }

      try {
        const saved = await this.workflowRunRepository.updateWithVersion(entity.id, entity, entity.version);
        if (cancelling) {
          this.broadcastRunFinished(saved, input.tenantId, endedAt, input.terminalReason ?? null, input.consultationId ?? null);
        }
        return WorkflowRunDtoMapper.toResponse(saved);
      } catch (error) {
        // The run's own completion watcher may write its terminal status between the read and this
        // write. Re-read and decide again, so a run that just finished is not turned into CANCELED.
        if (!(error instanceof OptimisticConcurrencyException) || attempt >= SUPERSEDE_WRITE_ATTEMPTS - 1) throw error;
      }
    }
  }

  /** The `workflow.run.completed` sys-event — see `recordRunFinished`. PHI-free by construction. */
  private broadcastRunFinished(
    saved: WorkflowRunEntity,
    tenantId: string,
    endedAt: Date,
    terminalReason: string | null,
    consultationId: string | null,
  ): void {
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: saved.id,
      resourceType: ResourceType.WorkflowRun,
      tenantId,
      data: {
        action: 'runFinished',
        runId: saved.runId,
        slug: saved.workflowSlug,
        workflowVersionNumber: saved.workflowVersionNumber,
        status: saved.status,
        terminalReason,
        startedAt: saved.startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        consultationId,
      },
    });
  }

  /**
   * A run reaches this plane under one of two session keys: the exposure plane's own
   * (`invoke` / sandbox) or the consultation dispatcher's (`wf-<runId>`). Same tenant scope,
   * same 404-over-403 posture either way; the key is only which row the run was anchored as.
   * Declared once so the read path and the terminal write cannot resolve differently.
   */
  private async findRunByConventionalSessionKeys(tenantId: string, runId: string): Promise<WorkflowRunEntity | null> {
    return (
      (await this.workflowRunRepository.findByRunKey(tenantId, interpreterSessionId(runId), runId)) ??
      (await this.workflowRunRepository.findByRunKey(tenantId, consultationDispatchSessionId(runId), runId))
    );
  }

  /** 404-over-403: a cross-tenant or nonexistent run id both raise `NotFoundException`. */
  private async findRunOrThrow(tenantId: string, runId: string): Promise<WorkflowRunEntity> {
    const entity = await this.findRunByConventionalSessionKeys(tenantId, runId);
    if (!entity) {
      throw workflowRunNotFound(runId);
    }
    return entity;
  }
}
