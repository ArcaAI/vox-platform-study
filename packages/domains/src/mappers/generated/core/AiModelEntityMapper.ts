import {
    AutoClassMapper,
    AutoEntityChangeMapper,
    BaseMapper,
    createMapperHandlers,
} from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

export class AiModelEntityMapper extends BaseMapper<Entities.AiModelEntity, Models.AiModel> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.AiModelEntity): Models.AiModel {
        return AutoClassMapper(
            entity,
            Models.AiModel,
            AiModelEntityMapperHandlers.$toPersistence,
        );
    }

    public toPersistenceChanges(entity: Entities.AiModelEntity): Partial<Models.AiModel> {
        return AutoEntityChangeMapper(
            entity,
            Models.AiModel,
            AiModelEntityMapperHandlers.$toPersistence,
        );
    }

    public toDomainEntity(dataModel: Models.AiModel): Entities.AiModelEntity {
        return AutoClassMapper(
            dataModel,
            Entities.AiModelEntity,
            AiModelEntityMapperHandlers.$toDomain,
        );
    }
}

export const AiModelEntityMapperHandlers = createMapperHandlers<Entities.AiModelEntity, Models.AiModel>({
    $toPersistence: {
    },
    $toDomain: {
    },
});
