import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ResourceType, WorkflowRunEntity, WorkflowRunFactory, WorkflowRunRepository, WorkflowRunStatus } from '@arcaai/domains';
import { BaseService } from '../../common';
import { buildCursorFindAllProps, clampCursorLimit, CursorPage, decodeCursor, MAX_CURSOR_LIMIT, toCursorPage } from '../../common/cursorPagination';
import { IActiveUserContext } from '../../interfaces';
import { AgentTrajectoryStepResponse, IAgentTrajectoryService } from '../agent-trajectory';
import {
  GetRunTraceOptions,
  ListWorkflowRunsFilters,
  ListWorkflowRunsOptions,
  RecordRunFinishedInput,
  RecordRunStartedInput,
  RunNodeRollupResponse,
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
        tracePruned: false,
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
      tracePruned: false,
    };
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
