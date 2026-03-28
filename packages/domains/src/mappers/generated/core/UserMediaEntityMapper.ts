import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class UserMediaEntityMapper extends BaseMapper<Entities.UserMediaEntity, Models.UserMedia> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.UserMediaEntity): Models.UserMedia {
    return AutoClassMapper(entity, Models.UserMedia, UserMediaEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.UserMediaEntity): Partial<Models.UserMedia> {
    return AutoEntityChangeMapper(entity, Models.UserMedia, UserMediaEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.UserMedia): Entities.UserMediaEntity {
    return AutoClassMapper(dataModel, Entities.UserMediaEntity, UserMediaEntityMapperHandlers.$toDomain);
  }
}

export const UserMediaEntityMapperHandlers = createMapperHandlers<Entities.UserMediaEntity, Models.UserMedia>({
  $toPersistence: {
    userId: (obj: Entities.UserMediaEntity) => obj.User?.id || null,
    mediaId: (obj: Entities.UserMediaEntity) => obj.Media?.id || null,
  },
  $toDomain: {
    User: (obj: Models.UserMedia) => (obj.User ? Mappers.UserEntityMapper.getInstance().toDomainEntity(obj.User) : null),
    Media: (obj: Models.UserMedia) => (obj.Media ? Mappers.MediaEntityMapper.getInstance().toDomainEntity(obj.Media) : null),
  },
});
