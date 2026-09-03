import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. `Agent` IS OCC-written (admin PATCH routes
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

export class AgentEntityMapper extends BaseMapper<Entities.AgentEntity, Models.Agent> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AgentEntity): Models.Agent {
    const result = AutoClassMapper(entity, Models.Agent, AgentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.AgentEntity): Partial<Models.Agent> {
    const result = AutoEntityChangeMapper(entity, Models.Agent, AgentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.Agent): Entities.AgentEntity {
    return AutoClassMapper(dataModel, Entities.AgentEntity, AgentEntityMapperHandlers.$toDomain);
  }
}

export const AgentEntityMapperHandlers = createMapperHandlers<Entities.AgentEntity, Models.Agent>({
  $toPersistence: {},
  $toDomain: {},
});
