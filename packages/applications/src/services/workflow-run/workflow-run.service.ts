import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ResourceType, WorkflowRunEntity, WorkflowRunFactory, WorkflowRunRepository, WorkflowRunStatus } from '@arcaai/domains';
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
  RunNodeRollupResponse,
  RunGateStateResponse,
  RunTraceResponse,
  WorkflowRunResponse,
} from './dto';
import { IWorkflowRunService } from './IWorkflowRunService';
import { WorkflowRunDtoMapper } from './workflow-run.dto.mapper';

/** Mirrors `interpreter_workflow_id()` (apps/harness/.../interpreter/workflow.py:52-58) — see the
 * Task 1 contract (`docs/implementation/TASK-723-Runs-Observability/contracts/run-read-model.contract.md`
 * §2) for exactly why `sessionId` — not the trajectory row's own `runId` column — is the correct
 * join key onto `AgentTrajectoryStep`. */
export const INTERPRETER_WORKFLOW_ID_PREFIX = 'workflow-interpreter-';
export function interpreterSessionId(runId: string): string {
  return `${INTERPRETER_WORKFLOW_ID_PREFIX}${runId}`;
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
 * / Task 1 contract §3 — no attempt column exists anywhere). A non-consecutive
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
 * WorkflowRunService — the runs/observability read model (TASK-723). D6's
 * "CQRS-lite ... read models for runs/observability".
 *
 * INTENTIONAL posture (mirrors AgentTrajectoryService, its sibling telemetry
 * service):
 *   - NO sys-event on write — a run row is a telemetry fact, same exemption
 *     as AgentTrajectoryStep (see WorkflowRunEntity header).
 *   - `recordRunStarted`/`recordRunFinished` are IDEMPOTENT on
 *     `(tenantId, sessionId, runId)` — the write contract TASK-718's
 *     dispatcher (or a future gateway controller) calls. As of this ticket
 *     nothing calls them yet (Task 1 contract §7 / README R2).
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

    const where: Record<string, unknown> = { tenantId };
    if (filters.workflowSlug) where.workflowSlug = filters.workflowSlug;
    if (filters.workflowVersionId) where.workflowVersionId = filters.workflowVersionId;
    if (filters.status) where.status = filters.status;
    if (filters.trigger) where.trigger = filters.trigger;
    // Single query-level filter point (Task 1 contract §4) — sandbox runs are
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
    const saved = await this.workflowRunRepository.create(entity);
    // NO sys-event — telemetry exemption (see WorkflowRunEntity header).
    return WorkflowRunDtoMapper.toResponse(saved);
  }

  async recordRunFinished(input: RecordRunFinishedInput): Promise<WorkflowRunResponse> {
    const entity = await this.workflowRunRepository.findByRunKey(input.tenantId, input.sessionId, input.runId ?? '');
    if (!entity) {
      throw new NotFoundException(`WorkflowRun for run ${input.runId} not found`);
    }

    entity.status = input.status as WorkflowRunStatus;
    const endedAt = input.endedAt ?? new Date();
    entity.endedAt = endedAt;
    entity.durationMs = Math.max(0, endedAt.getTime() - entity.startedAt.getTime());
    if (input.nodeCount !== undefined) entity.nodeCount = input.nodeCount;
    if (input.failedNodeCount !== undefined) entity.failedNodeCount = input.failedNodeCount;
    if (input.degradedNodeCount !== undefined) entity.degradedNodeCount = input.degradedNodeCount;
    if (input.firstErrorCode !== undefined) entity.firstErrorCode = input.firstErrorCode;
    // TASK-790 (M-2). `undefined` means the caller reported no delivered output (a graph with no
    // `output.deliver` node) and must leave any existing value alone; an explicit `null` clears it.
    if (input.resultRef !== undefined) entity.resultRef = input.resultRef as never;

    if (!entity.hasChanges) {
      return WorkflowRunDtoMapper.toResponse(entity);
    }
    const saved = await this.workflowRunRepository.updateWithVersion(entity.id, entity, entity.version);
    // NO sys-event — telemetry exemption.
    return WorkflowRunDtoMapper.toResponse(saved);
  }

  /** 404-over-403: a cross-tenant or nonexistent run id both raise `NotFoundException`. */
  private async findRunOrThrow(tenantId: string, runId: string): Promise<WorkflowRunEntity> {
    const sessionId = interpreterSessionId(runId);
    const entity = await this.workflowRunRepository.findByRunKey(tenantId, sessionId, runId);
    if (!entity) {
      throw new NotFoundException(`WorkflowRun ${runId} not found`);
    }
    return entity;
  }
}
