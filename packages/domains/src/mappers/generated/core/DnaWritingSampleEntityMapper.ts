import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database; strip it from every write path.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class DnaWritingSampleEntityMapper extends BaseMapper<Entities.DnaWritingSampleEntity, Models.DnaWritingSample> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.DnaWritingSampleEntity): Models.DnaWritingSample {
    const result = AutoClassMapper(entity, Models.DnaWritingSample, DnaWritingSampleEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.DnaWritingSampleEntity): Partial<Models.DnaWritingSample> {
    const result = AutoEntityChangeMapper(entity, Models.DnaWritingSample, DnaWritingSampleEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.DnaWritingSample): Entities.DnaWritingSampleEntity {
    return AutoClassMapper(dataModel, Entities.DnaWritingSampleEntity, DnaWritingSampleEntityMapperHandlers.$toDomain);
  }
}

export const DnaWritingSampleEntityMapperHandlers = createMapperHandlers<Entities.DnaWritingSampleEntity, Models.DnaWritingSample>({
  $toPersistence: {
    // Return the raw ciphertext Buffers so the auto-mapper does not destructure them.
    textCiphertext: (entity) => entity.textCiphertext ?? null,
    aiDraftCiphertext: (entity) => entity.aiDraftCiphertext ?? null,
  },
  $toDomain: {
    textCiphertext: (model) => (model.textCiphertext ? Buffer.from(model.textCiphertext) : null),
    aiDraftCiphertext: (model) => (model.aiDraftCiphertext ? Buffer.from(model.aiDraftCiphertext) : null),
  },
});
