import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { WorkflowRunEntityMapper } from '../../../mappers';
import { WorkflowRunEntity } from '../../../entities';
import { WorkflowRun } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/**
 * The runs/observability read-model repository (TASK-723).
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
   */
  async findByRunKey(tenantId: string, sessionId: string, runId: string): Promise<WorkflowRunEntity | null> {
    const rows = await this.findAll({
      filters: { tenantId, sessionId, runId },
    });
    return rows[0] ?? null;
  }
}
