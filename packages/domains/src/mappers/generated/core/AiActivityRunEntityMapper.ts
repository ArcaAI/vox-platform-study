import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `AiActivityRun` keeps `_metadata` / `_version` / audit columns but has NO
// `resourceStatus*` columns (append-only telemetry, MODELS_WITHOUT_SOFT_DELETE).
// `resourceStatus*` and the DB-owned `version` are stripped from every write.
const FIELDS_NOT_WRITABLE: string[] = ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class AiActivityRunEntityMapper extends BaseMapper<Entities.AiActivityRunEntity, Models.AiActivityRun> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AiActivityRunEntity): Models.AiActivityRun {
    const result = AutoClassMapper(entity, Models.AiActivityRun, AiActivityRunEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.AiActivityRunEntity): Partial<Models.AiActivityRun> {
    const result = AutoEntityChangeMapper(entity, Models.AiActivityRun, AiActivityRunEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.AiActivityRun): Entities.AiActivityRunEntity {
    return AutoClassMapper(dataModel, Entities.AiActivityRunEntity, AiActivityRunEntityMapperHandlers.$toDomain);
  }
}

export const AiActivityRunEntityMapperHandlers = createMapperHandlers<Entities.AiActivityRunEntity, Models.AiActivityRun>({
  $toPersistence: {},
  $toDomain: {},
});
