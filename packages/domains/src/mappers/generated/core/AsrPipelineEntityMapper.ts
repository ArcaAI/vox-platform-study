import {
    AutoClassMapper,
    AutoEntityChangeMapper,
    BaseMapper,
    createMapperHandlers,
} from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class AsrPipelineEntityMapper extends BaseMapper<Entities.AsrPipelineEntity, Models.AsrPipeline> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.AsrPipelineEntity): Models.AsrPipeline {
        return AutoClassMapper(
            entity,
            Models.AsrPipeline,
            AsrPipelineEntityMapperHandlers.$toPersistence,
        );
    }

    public toPersistenceChanges(entity: Entities.AsrPipelineEntity): Partial<Models.AsrPipeline> {
        return AutoEntityChangeMapper(
            entity,
            Models.AsrPipeline,
            AsrPipelineEntityMapperHandlers.$toPersistence,
        );
    }

    public toDomainEntity(dataModel: Models.AsrPipeline): Entities.AsrPipelineEntity {
        return AutoClassMapper(
            dataModel,
            Entities.AsrPipelineEntity,
            AsrPipelineEntityMapperHandlers.$toDomain,
        );
    }
}

export const AsrPipelineEntityMapperHandlers = createMapperHandlers<Entities.AsrPipelineEntity, Models.AsrPipeline>({
    $toPersistence: {
        // Handle TranscriptionJobs relation - exclude from persistence
        TranscriptionJobs: () => undefined,
    },
    $toDomain: {
        // Handle TranscriptionJobs relation mapping
        TranscriptionJobs: (obj: any) => {
            if (!obj.TranscriptionJobs || obj.TranscriptionJobs.length === 0) return undefined;
            const mapper = Mappers.TranscriptionJobEntityMapper.getInstance();
            return obj.TranscriptionJobs.map((job: any) => mapper.toDomainEntity(job));
        },
    },
});
