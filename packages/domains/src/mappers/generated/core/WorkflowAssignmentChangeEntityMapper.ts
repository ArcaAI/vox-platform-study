import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

/**
 * The `WorkflowAssignmentChange` table is append-only (WORM) and intentionally
 * has NO `_metadata` / `_version` / `createdBy` / `updatedBy` / `updatedAt` /
 * `resourceStatus*` columns. The base entity/model carry those inherited
 * fields, so strip them before persistence to avoid "Unknown argument" Prisma
 * errors. Only `id`, `tenantId`, `createdAt` and the business columns are
 * written. Mirrors `PipelinePolicyChangeEntityMapper`.
 */
function stripNonPersistedFields<T>(model: T): T {
  const raw = model as unknown as Record<string, unknown>;
  delete raw.metaData;
  delete raw.version;
  delete raw.createdBy;
  delete raw.updatedBy;
  delete raw.updatedAt;
  delete raw.resourceStatus;
  delete raw.resourceStatusUpdatedAt;
  delete raw.resourceStatusUpdatedBy;
  return model;
}

export class WorkflowAssignmentChangeEntityMapper extends BaseMapper<Entities.WorkflowAssignmentChangeEntity, Models.WorkflowAssignmentChange> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.WorkflowAssignmentChangeEntity): Models.WorkflowAssignmentChange {
    const model = AutoClassMapper(entity, Models.WorkflowAssignmentChange, WorkflowAssignmentChangeEntityMapperHandlers.$toPersistence);
    return stripNonPersistedFields(model);
  }

  public toPersistenceChanges(entity: Entities.WorkflowAssignmentChangeEntity): Partial<Models.WorkflowAssignmentChange> {
    const model = AutoEntityChangeMapper(entity, Models.WorkflowAssignmentChange, WorkflowAssignmentChangeEntityMapperHandlers.$toPersistence);
    return stripNonPersistedFields(model);
  }

  public toDomainEntity(dataModel: Models.WorkflowAssignmentChange): Entities.WorkflowAssignmentChangeEntity {
    return AutoClassMapper(dataModel, Entities.WorkflowAssignmentChangeEntity, WorkflowAssignmentChangeEntityMapperHandlers.$toDomain);
  }
}

export const WorkflowAssignmentChangeEntityMapperHandlers = createMapperHandlers<
  Entities.WorkflowAssignmentChangeEntity,
  Models.WorkflowAssignmentChange
>({
  $toPersistence: {},
  $toDomain: {},
});
