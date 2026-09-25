import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

export class TranscriptionJobEntityMapper extends BaseMapper<Entities.TranscriptionJobEntity, Models.TranscriptionJob> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TranscriptionJobEntity): Models.TranscriptionJob {
    return AutoClassMapper(entity, Models.TranscriptionJob, TranscriptionJobEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.TranscriptionJobEntity): Partial<Models.TranscriptionJob> {
    return AutoEntityChangeMapper(entity, Models.TranscriptionJob, TranscriptionJobEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.TranscriptionJob): Entities.TranscriptionJobEntity {
    return AutoClassMapper(dataModel, Entities.TranscriptionJobEntity, TranscriptionJobEntityMapperHandlers.$toDomain);
  }
}

export const TranscriptionJobEntityMapperHandlers = createMapperHandlers<Entities.TranscriptionJobEntity, Models.TranscriptionJob>({
  $toPersistence: {
    // Return the raw ciphertext Buffer directly so the
    // generic auto-mapper does not destructure the typed array.
    encryptedResultText: (entity) => entity.encryptedResultText ?? null,
    encryptedResultMetadata: (entity) => entity.encryptedResultMetadata ?? null,
  },
  $toDomain: {
    encryptedResultText: (model) => model.encryptedResultText ?? null,
    encryptedResultMetadata: (model) => model.encryptedResultMetadata ?? null,
  },
});
