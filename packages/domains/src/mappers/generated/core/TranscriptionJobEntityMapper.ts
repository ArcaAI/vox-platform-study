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
  },
  $toDomain: {
    // Handle Pipeline relation mapping
    Pipeline: (obj: any) => {
      if (!obj.Pipeline) return undefined;
      const mapper = Mappers.AsrPipelineEntityMapper.getInstance();
      return mapper.toDomainEntity(obj.Pipeline);
    },
  },
});
