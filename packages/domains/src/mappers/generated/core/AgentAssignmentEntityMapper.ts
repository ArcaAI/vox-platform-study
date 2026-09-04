import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. `AgentAssignment` IS OCC-written (admin PATCH routes
// carry If-Match against this row), so the strip is load-bearing: without it
// the auto-mappers leak `version` into a Prisma update and every
// compare-and-set silently stops meaning anything. Mirrors
// `WorkflowDefinitionEntityMapper`.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class AgentAssignmentEntityMapper extends BaseMapper<Entities.AgentAssignmentEntity, Models.AgentAssignment> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AgentAssignmentEntity): Models.AgentAssignment {
    const result = AutoClassMapper(entity, Models.AgentAssignment, AgentAssignmentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.AgentAssignmentEntity): Partial<Models.AgentAssignment> {
    const result = AutoEntityChangeMapper(entity, Models.AgentAssignment, AgentAssignmentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.AgentAssignment): Entities.AgentAssignmentEntity {
    return AutoClassMapper(dataModel, Entities.AgentAssignmentEntity, AgentAssignmentEntityMapperHandlers.$toDomain);
  }
}

export const AgentAssignmentEntityMapperHandlers = createMapperHandlers<Entities.AgentAssignmentEntity, Models.AgentAssignment>({
  $toPersistence: {},
  $toDomain: {},
});
