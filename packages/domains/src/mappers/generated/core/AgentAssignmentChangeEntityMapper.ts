import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

/**
 * The `AgentAssignmentChange` table is append-only (WORM) and intentionally
 * has NO `_metadata` / `_version` / `createdBy` / `updatedBy` / `updatedAt` /
 * `resourceStatus*` columns. Strip the inherited base fields before
 * persistence to avoid "Unknown argument" Prisma errors. Mirrors
 * `WorkflowAssignmentChangeEntityMapper`.
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

export class AgentAssignmentChangeEntityMapper extends BaseMapper<Entities.AgentAssignmentChangeEntity, Models.AgentAssignmentChange> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AgentAssignmentChangeEntity): Models.AgentAssignmentChange {
    const model = AutoClassMapper(entity, Models.AgentAssignmentChange, AgentAssignmentChangeEntityMapperHandlers.$toPersistence);
    return stripNonPersistedFields(model);
  }

  public toPersistenceChanges(entity: Entities.AgentAssignmentChangeEntity): Partial<Models.AgentAssignmentChange> {
    const model = AutoEntityChangeMapper(entity, Models.AgentAssignmentChange, AgentAssignmentChangeEntityMapperHandlers.$toPersistence);
    return stripNonPersistedFields(model);
  }

  public toDomainEntity(dataModel: Models.AgentAssignmentChange): Entities.AgentAssignmentChangeEntity {
    return AutoClassMapper(dataModel, Entities.AgentAssignmentChangeEntity, AgentAssignmentChangeEntityMapperHandlers.$toDomain);
  }
}

export const AgentAssignmentChangeEntityMapperHandlers = createMapperHandlers<Entities.AgentAssignmentChangeEntity, Models.AgentAssignmentChange>({
  $toPersistence: {},
  $toDomain: {},
});
