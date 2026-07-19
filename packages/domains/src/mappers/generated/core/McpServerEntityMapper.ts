import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. Mirrors the
// `AiTaskDefaultEntityMapper` treatment.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class McpServerEntityMapper extends BaseMapper<Entities.McpServerEntity, Models.McpServer> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.McpServerEntity): Models.McpServer {
    const result = AutoClassMapper(entity, Models.McpServer, McpServerEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.McpServerEntity): Partial<Models.McpServer> {
    const result = AutoEntityChangeMapper(entity, Models.McpServer, McpServerEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.McpServer): Entities.McpServerEntity {
    return AutoClassMapper(dataModel, Entities.McpServerEntity, McpServerEntityMapperHandlers.$toDomain);
  }
}

export const McpServerEntityMapperHandlers = createMapperHandlers<Entities.McpServerEntity, Models.McpServer>({
  $toPersistence: {},
  $toDomain: {},
});
