import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

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
    // Handle Pipeline relation - exclude from persistence (use pipelineId)
    Pipeline: () => undefined,
    // TASK-369 Phase 3C — return the raw ciphertext Buffer directly so the
    // generic auto-mapper does not destructure the typed array.
    encryptedResultText: (entity) => entity.encryptedResultText ?? null,
    encryptedResultMetadata: (entity) => entity.encryptedResultMetadata ?? null,
  },
  $toDomain: {
    // Handle Pipeline relation mapping
    Pipeline: (obj: any) => {
      if (!obj.Pipeline) return undefined;
      const mapper = Mappers.AsrPipelineEntityMapper.getInstance();
      return mapper.toDomainEntity(obj.Pipeline);
    },
    encryptedResultText: (model) => model.encryptedResultText ?? null,
    encryptedResultMetadata: (model) => model.encryptedResultMetadata ?? null,
  },
});
