import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class NotificationEntityMapper extends BaseMapper<Entities.NotificationEntity, Models.Notification> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.NotificationEntity): Models.Notification {
    return AutoClassMapper(entity, Models.Notification, NotificationEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.NotificationEntity): Partial<Models.Notification> {
    return AutoEntityChangeMapper(entity, Models.Notification, NotificationEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.Notification): Entities.NotificationEntity {
    return AutoClassMapper(dataModel, Entities.NotificationEntity, NotificationEntityMapperHandlers.$toDomain);
  }
}

export const NotificationEntityMapperHandlers = createMapperHandlers<Entities.NotificationEntity, Models.Notification>({
  $toPersistence: {
    resourceSubscriptionId: (obj: Entities.NotificationEntity) => obj.ResourceSubscription?.id || null,
    targetUserId: (obj: Entities.NotificationEntity) => obj.TargetUser?.id || null,
  },
  $toDomain: {
    ResourceSubscription: (obj: Models.Notification) =>
      obj.ResourceSubscription ? Mappers.ResourceSubscriptionEntityMapper.getInstance().toDomainEntity(obj.ResourceSubscription) : null,
    TargetUser: (obj: Models.Notification) => (obj.TargetUser ? Mappers.UserEntityMapper.getInstance().toDomainEntity(obj.TargetUser) : null),
  },
});
