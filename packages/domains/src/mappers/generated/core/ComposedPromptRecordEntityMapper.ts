import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// APPEND-ONLY model (written once, never updated through a versioned route), so there is no
// `_version` strip: nothing writes it after the insert, where the database default owns it.
export class ComposedPromptRecordEntityMapper extends BaseMapper<Entities.ComposedPromptRecordEntity, Models.ComposedPromptRecord> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ComposedPromptRecordEntity): Models.ComposedPromptRecord {
    return AutoClassMapper(entity, Models.ComposedPromptRecord, ComposedPromptRecordEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.ComposedPromptRecordEntity): Partial<Models.ComposedPromptRecord> {
    return AutoEntityChangeMapper(entity, Models.ComposedPromptRecord, ComposedPromptRecordEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.ComposedPromptRecord): Entities.ComposedPromptRecordEntity {
    return AutoClassMapper(dataModel, Entities.ComposedPromptRecordEntity, ComposedPromptRecordEntityMapperHandlers.$toDomain);
  }
}

export const ComposedPromptRecordEntityMapperHandlers = createMapperHandlers<Entities.ComposedPromptRecordEntity, Models.ComposedPromptRecord>({
  $toPersistence: {
    // Return the raw ciphertext Buffers so the auto-mapper does not destructure them.
    systemCiphertext: (entity) => entity.systemCiphertext ?? null,
    userCiphertext: (entity) => entity.userCiphertext ?? null,
  },
  $toDomain: {
    systemCiphertext: (model) => (model.systemCiphertext ? Buffer.from(model.systemCiphertext) : null),
    userCiphertext: (model) => (model.userCiphertext ? Buffer.from(model.userCiphertext) : null),
  },
});
