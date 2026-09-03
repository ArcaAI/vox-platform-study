import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { WorkflowAssignmentChangeEntity } from '../../../entities';
import { WorkflowAssignmentChangeEntityMapper } from '../../../mappers';
import { WorkflowAssignmentChange } from '../../../models';

/**
 * Append-only WORM workflow-assignment-change repository. Writes go
 * through the inherited `create`; there is intentionally no update/delete
 * surface (the migration REVOKEs those privileges). `id` is a time-sortable
 * UUIDv7, so ordering by `id` reflects append order. Mirrors
 * `PipelinePolicyChangeRepository`.
 */
@Injectable()
export class WorkflowAssignmentChangeRepository extends Repository<WorkflowAssignmentChangeEntity, WorkflowAssignmentChange> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'workflowAssignmentChange', WorkflowAssignmentChangeEntityMapper.getInstance());
  }

  /** Assignment-change records for a tenant, newest → oldest. */
  async listForTenant(tenantId: string): Promise<WorkflowAssignmentChangeEntity[]> {
    return this.findAll({
      filters: { tenantId },
      sort: [{ id: 'desc' }],
    });
  }
}
