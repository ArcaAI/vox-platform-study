import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

export class UserVoiceProfileEntityMapper extends BaseMapper<Entities.UserVoiceProfileEntity, Models.UserVoiceProfile> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.UserVoiceProfileEntity): Models.UserVoiceProfile {
    return AutoClassMapper(entity, Models.UserVoiceProfile, UserVoiceProfileEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.UserVoiceProfileEntity): Partial<Models.UserVoiceProfile> {
    return AutoEntityChangeMapper(entity, Models.UserVoiceProfile, UserVoiceProfileEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.UserVoiceProfile): Entities.UserVoiceProfileEntity {
    return AutoClassMapper(dataModel, Entities.UserVoiceProfileEntity, UserVoiceProfileEntityMapperHandlers.$toDomain);
  }
}

export const UserVoiceProfileEntityMapperHandlers = createMapperHandlers<Entities.UserVoiceProfileEntity, Models.UserVoiceProfile>({
  $toPersistence: {},
  $toDomain: {},
});
