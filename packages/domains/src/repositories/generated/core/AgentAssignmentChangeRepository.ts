import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AgentAssignmentChangeEntity } from '../../../entities';
import { AgentAssignmentChangeEntityMapper } from '../../../mappers';
import { AgentAssignmentChange } from '../../../models';

/**
 * Append-only WORM agent-assignment-change repository (TASK-863). Writes go
 * through the inherited `create`; there is intentionally no update/delete
 * surface, and the `agent_assignment_change_worm_guard` trigger refuses both
 * at the DB layer. `id` is a time-sortable UUIDv7, so ordering by `id`
 * reflects append order.
 */
@Injectable()
export class AgentAssignmentChangeRepository extends Repository<AgentAssignmentChangeEntity, AgentAssignmentChange> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'agentAssignmentChange', AgentAssignmentChangeEntityMapper.getInstance());
  }

  /** Assignment-change records for a tenant, newest → oldest. */
  async listForTenant(tenantId: string): Promise<AgentAssignmentChangeEntity[]> {
    return this.findAll({
      filters: { tenantId },
      sort: [{ id: 'desc' }],
    });
  }
}
