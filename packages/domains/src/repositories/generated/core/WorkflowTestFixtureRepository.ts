import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { WorkflowTestFixtureEntity } from '../../../entities';
import { WorkflowTestFixtureEntityMapper } from '../../../mappers';
import { WorkflowTestFixture } from '../../../models';

/**
 * Per-tenant saved synthetic Workbench test input (TASK-721). Plain
 * tenant-scoped CRUD — no cross-aggregate lookups beyond the standard
 * `Repository<Entity, Model>` contract.
 */
@Injectable()
export class WorkflowTestFixtureRepository extends Repository<WorkflowTestFixtureEntity, WorkflowTestFixture> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'workflowTestFixture', WorkflowTestFixtureEntityMapper.getInstance());
  }
}
