import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// HAND-AUTHORED (the `gen:mapper` generator crashes pre-existingly;
// see the AiTaskDefaultEntityMapper precedent in this folder).
//
// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. This model IS OCC-written
// (versioned PATCH routes on `admin/ai-runtime-profiles`).
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) delete (model as Record<string, unknown>)[field];
  return model;
}

export class AiRuntimeProfileEntityMapper extends BaseMapper<
  Entities.AiRuntimeProfileEntity,
  Models.AiRuntimeProfile
> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AiRuntimeProfileEntity): Models.AiRuntimeProfile {
    const result = AutoClassMapper(
      entity,
      Models.AiRuntimeProfile,
      AiRuntimeProfileEntityMapperHandlers.$toPersistence,
    );
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.AiRuntimeProfileEntity): Partial<Models.AiRuntimeProfile> {
    const result = AutoEntityChangeMapper(
      entity,
      Models.AiRuntimeProfile,
      AiRuntimeProfileEntityMapperHandlers.$toPersistence,
    );
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.AiRuntimeProfile): Entities.AiRuntimeProfileEntity {
    return AutoClassMapper(
      dataModel,
      Entities.AiRuntimeProfileEntity,
      AiRuntimeProfileEntityMapperHandlers.$toDomain,
    );
  }
}

export const AiRuntimeProfileEntityMapperHandlers = createMapperHandlers<
  Entities.AiRuntimeProfileEntity,
  Models.AiRuntimeProfile
>({
  $toPersistence: {},
  $toDomain: {},
});
