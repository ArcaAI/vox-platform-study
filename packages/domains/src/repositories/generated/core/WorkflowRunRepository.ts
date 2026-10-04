import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { WorkflowRunEntityMapper } from '../../../mappers';
import { WorkflowRunEntity } from '../../../entities';
import { WorkflowRunKind } from '../../../enums';
import { agentRunSessionId } from '../../../factories/generated/core/WorkflowRunFactory';
import { WorkflowRun } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/**
 * The runs/observability read-model repository.
 *
 * `WorkflowRun` is TENANT-SCOPED operational telemetry — the same posture as
 * `AgentTrajectoryStepRepository`, deliberately exempt from two platform
 * conventions:
 *   - SOFT-DELETE: the model is in MODELS_WITHOUT_SOFT_DELETE and has no
 *     `resourceStatus` column, so `softDelete()`/`restore()` throw.
 *   - SYS-EVENTS: writes emit NO sys-event (telemetry exemption).
 * Cross-tenant isolation is enforced upstream by the shared tenant-scope
 * `$extends` (tenant-scope.ts, whose drift guard lists WorkflowRun); every
 * finder here is additionally scoped by an explicit `tenantId` filter.
 */
@Injectable()
export class WorkflowRunRepository extends Repository<WorkflowRunEntity, WorkflowRun> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'workflowRun', WorkflowRunEntityMapper.getInstance());
  }

  /**
   * Idempotency lookup for `recordRunStarted`: a run row is keyed uniquely by
   * `(tenantId, sessionId, runId)` (`WorkflowRun_session_run_key`). Uses
   * `findAll` (not the base `findFirst`, which THROWS `DataNotFoundException`
   * on a miss) so a caller can treat "no row yet" as a normal, non-exceptional
   * case.
   *
   * TASK-1038 OD-26 — WORKFLOW rows only. The table also holds AGENT runs; every workflow path
   * (exposure plane, consultation dispatch, sandbox, governing-workflow ASR, completion watcher)
   * reaches its row through this lookup, so the kind filter here is what keeps an agent run out
   * of all of them. Agent runs are read with `findAgentRun`.
   */
  async findByRunKey(tenantId: string, sessionId: string, runId: string): Promise<WorkflowRunEntity | null> {
    const rows = await this.findAll({
      filters: { tenantId, sessionId, runId, kind: WorkflowRunKind.WORKFLOW },
    });
    return rows[0] ?? null;
  }

  /**
   * TASK-1038 OD-26 — one AGENT run (`POST /agents/:slug/runs`) by its run id, within the tenant.
   * Reads the unique key `(tenantId, 'agent-run-' + runId, runId)` with `kind = AGENT`, so a
   * workflow run id never resolves here. `null` on a miss — the caller owns the 404 (and checks
   * the run belongs to the slug it was addressed under).
   */
  async findAgentRun(tenantId: string, runId: string): Promise<WorkflowRunEntity | null> {
    const rows = await this.findAll({
      filters: { tenantId, sessionId: agentRunSessionId(runId), runId, kind: WorkflowRunKind.AGENT },
    });
    return rows[0] ?? null;
  }
}
