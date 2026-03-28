import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class UserProfileEntityMapper extends BaseMapper<Entities.UserProfileEntity, Models.UserProfile> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.UserProfileEntity): Models.UserProfile {
    return AutoClassMapper(entity, Models.UserProfile, UserProfileEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.UserProfileEntity): Partial<Models.UserProfile> {
    return AutoEntityChangeMapper(entity, Models.UserProfile, UserProfileEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.UserProfile): Entities.UserProfileEntity {
    return AutoClassMapper(dataModel, Entities.UserProfileEntity, UserProfileEntityMapperHandlers.$toDomain);
  }
}

export const UserProfileEntityMapperHandlers = createMapperHandlers<Entities.UserProfileEntity, Models.UserProfile>({
  $toPersistence: {
    userId: (obj: Entities.UserProfileEntity) => obj.User?.id || null,
  },
  $toDomain: {
    User: (obj: Models.UserProfile) => (obj.User ? Mappers.UserEntityMapper.getInstance().toDomainEntity(obj.User) : null),
  },
});
