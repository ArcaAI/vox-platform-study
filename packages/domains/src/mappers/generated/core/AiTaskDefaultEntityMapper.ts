import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. Mirrors the
// `DepartmentEntityMapper` treatment.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class AiTaskDefaultEntityMapper extends BaseMapper<Entities.AiTaskDefaultEntity, Models.AiTaskDefault> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AiTaskDefaultEntity): Models.AiTaskDefault {
    const result = AutoClassMapper(entity, Models.AiTaskDefault, AiTaskDefaultEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.AiTaskDefaultEntity): Partial<Models.AiTaskDefault> {
    const result = AutoEntityChangeMapper(entity, Models.AiTaskDefault, AiTaskDefaultEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.AiTaskDefault): Entities.AiTaskDefaultEntity {
    return AutoClassMapper(dataModel, Entities.AiTaskDefaultEntity, AiTaskDefaultEntityMapperHandlers.$toDomain);
  }
}

export const AiTaskDefaultEntityMapperHandlers = createMapperHandlers<Entities.AiTaskDefaultEntity, Models.AiTaskDefault>({
  $toPersistence: {},
  $toDomain: {},
});
