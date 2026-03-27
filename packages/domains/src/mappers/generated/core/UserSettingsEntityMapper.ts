import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class UserSettingsEntityMapper extends BaseMapper<Entities.UserSettingsEntity, Models.UserSettings> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.UserSettingsEntity): Models.UserSettings {
    return AutoClassMapper(entity, Models.UserSettings, UserSettingsEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.UserSettingsEntity): Partial<Models.UserSettings> {
    return AutoEntityChangeMapper(entity, Models.UserSettings, UserSettingsEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.UserSettings): Entities.UserSettingsEntity {
    return AutoClassMapper(dataModel, Entities.UserSettingsEntity, UserSettingsEntityMapperHandlers.$toDomain);
  }
}

export const UserSettingsEntityMapperHandlers = createMapperHandlers<Entities.UserSettingsEntity, Models.UserSettings>({
  $toPersistence: {
    userId: (obj: Entities.UserSettingsEntity) => obj.User?.id || null,
  },
  $toDomain: {
    User: (obj: Models.UserSettings) => (obj.User ? Mappers.UserEntityMapper.getInstance().toDomainEntity(obj.User) : null),
  },
});
