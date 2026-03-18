import {
    AutoClassMapper,
    AutoEntityChangeMapper,
    BaseMapper,
    createMapperHandlers,
} from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class GlobalSettingEntityMapper extends BaseMapper<Entities.GlobalSettingEntity, Models.GlobalSetting> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.GlobalSettingEntity): Models.GlobalSetting {
        return AutoClassMapper(
            entity,
            Models.GlobalSetting,
            GlobalSettingEntityMapperHandlers.$toPersistence,
        );
    }

    public toPersistenceChanges(entity: Entities.GlobalSettingEntity): Partial<Models.GlobalSetting> {
        return AutoEntityChangeMapper(
            entity,
            Models.GlobalSetting,
            GlobalSettingEntityMapperHandlers.$toPersistence,
        );
    }

    public toDomainEntity(dataModel: Models.GlobalSetting): Entities.GlobalSettingEntity {
        return AutoClassMapper(
            dataModel,
            Entities.GlobalSettingEntity,
            GlobalSettingEntityMapperHandlers.$toDomain,
        );
    }
}

export const GlobalSettingEntityMapperHandlers = createMapperHandlers<Entities.GlobalSettingEntity, Models.GlobalSetting>({
    $toPersistence: {
    },
    $toDomain: {
    },
});