import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update (TASK-860 closed the gap
// this mapper had against every other OCC-written model — rule 03).
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class AiModelEntityMapper extends BaseMapper<Entities.AiModelEntity, Models.AiModel> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AiModelEntity): Models.AiModel {
    const result = AutoClassMapper(entity, Models.AiModel, AiModelEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.AiModelEntity): Partial<Models.AiModel> {
    const result = AutoEntityChangeMapper(entity, Models.AiModel, AiModelEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.AiModel): Entities.AiModelEntity {
    return AutoClassMapper(dataModel, Entities.AiModelEntity, AiModelEntityMapperHandlers.$toDomain);
  }
}

export const AiModelEntityMapperHandlers = createMapperHandlers<Entities.AiModelEntity, Models.AiModel>({
  $toPersistence: {},
  $toDomain: {},
});
