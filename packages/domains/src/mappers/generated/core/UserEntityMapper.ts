import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class UserEntityMapper extends BaseMapper<Entities.UserEntity, Models.User> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.UserEntity): Models.User {
    return AutoClassMapper(entity, Models.User, UserEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.UserEntity): Partial<Models.User> {
    return AutoEntityChangeMapper(entity, Models.User, UserEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.User): Entities.UserEntity {
    return AutoClassMapper(dataModel, Entities.UserEntity, UserEntityMapperHandlers.$toDomain);
  }
}

export const UserEntityMapperHandlers = createMapperHandlers<Entities.UserEntity, Models.User>({
  $toPersistence: {},
  $toDomain: {
    UserProfile: (obj: Models.User) => (obj.UserProfile ? Mappers.UserProfileEntityMapper.getInstance().toDomainEntity(obj.UserProfile) : null),
    UserSettings: (obj: Models.User) => obj.UserSettings?.map((item) => Mappers.UserSettingsEntityMapper.getInstance().toDomainEntity(item)) || [],
    UserRoleAssignments: (obj: Models.User) =>
      obj.UserRoleAssignments?.map((item) => Mappers.UserRoleAssignmentEntityMapper.getInstance().toDomainEntity(item)) || [],
    UserNotifications: (obj: Models.User) =>
      obj.UserNotifications?.map((item) => Mappers.NotificationEntityMapper.getInstance().toDomainEntity(item)) || [],
    ResourceSubscriptions: (obj: Models.User) =>
      obj.ResourceSubscriptions?.map((item) => Mappers.ResourceSubscriptionEntityMapper.getInstance().toDomainEntity(item)) || [],
    UserMedias: (obj: Models.User) => obj.UserMedias?.map((item) => Mappers.UserMediaEntityMapper.getInstance().toDomainEntity(item)) || [],
  },
});
