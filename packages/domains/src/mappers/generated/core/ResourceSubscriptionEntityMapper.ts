import {
    AutoClassMapper,
    AutoEntityChangeMapper,
    BaseMapper,
    createMapperHandlers,
} from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class ResourceSubscriptionEntityMapper extends BaseMapper<Entities.ResourceSubscriptionEntity, Models.ResourceSubscription> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.ResourceSubscriptionEntity): Models.ResourceSubscription {
        return AutoClassMapper(
            entity,
            Models.ResourceSubscription,
            ResourceSubscriptionEntityMapperHandlers.$toPersistence,
        );
    }

    public toPersistenceChanges(entity: Entities.ResourceSubscriptionEntity): Partial<Models.ResourceSubscription> {
        return AutoEntityChangeMapper(
            entity,
            Models.ResourceSubscription,
            ResourceSubscriptionEntityMapperHandlers.$toPersistence,
        );
    }

    public toDomainEntity(dataModel: Models.ResourceSubscription): Entities.ResourceSubscriptionEntity {
        return AutoClassMapper(
            dataModel,
            Entities.ResourceSubscriptionEntity,
            ResourceSubscriptionEntityMapperHandlers.$toDomain,
        );
    }
}

export const ResourceSubscriptionEntityMapperHandlers = createMapperHandlers<Entities.ResourceSubscriptionEntity, Models.ResourceSubscription>({
    $toPersistence: {
    },
    $toDomain: {
        Subscribers: (obj: Models.ResourceSubscription) => obj.Subscribers?.map(item => Mappers.UserEntityMapper.getInstance().toDomainEntity(item)) || [],
        Notifications: (obj: Models.ResourceSubscription) => obj.Notifications?.map(item => Mappers.NotificationEntityMapper.getInstance().toDomainEntity(item)) || [],
    },
});