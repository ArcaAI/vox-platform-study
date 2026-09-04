import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. `AgentModelFallback` IS OCC-written (admin PATCH routes
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

export class AgentModelFallbackEntityMapper extends BaseMapper<Entities.AgentModelFallbackEntity, Models.AgentModelFallback> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AgentModelFallbackEntity): Models.AgentModelFallback {
    const result = AutoClassMapper(entity, Models.AgentModelFallback, AgentModelFallbackEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.AgentModelFallbackEntity): Partial<Models.AgentModelFallback> {
    const result = AutoEntityChangeMapper(entity, Models.AgentModelFallback, AgentModelFallbackEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.AgentModelFallback): Entities.AgentModelFallbackEntity {
    return AutoClassMapper(dataModel, Entities.AgentModelFallbackEntity, AgentModelFallbackEntityMapperHandlers.$toDomain);
  }
}

export const AgentModelFallbackEntityMapperHandlers = createMapperHandlers<Entities.AgentModelFallbackEntity, Models.AgentModelFallback>({
  $toPersistence: {},
  $toDomain: {},
});
