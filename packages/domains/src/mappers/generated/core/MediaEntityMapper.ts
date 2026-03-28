import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class MediaEntityMapper extends BaseMapper<Entities.MediaEntity, Models.Media> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.MediaEntity): Models.Media {
    return AutoClassMapper(entity, Models.Media, MediaEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.MediaEntity): Partial<Models.Media> {
    return AutoEntityChangeMapper(entity, Models.Media, MediaEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.Media): Entities.MediaEntity {
    return AutoClassMapper(dataModel, Entities.MediaEntity, MediaEntityMapperHandlers.$toDomain);
  }
}

export const MediaEntityMapperHandlers = createMapperHandlers<Entities.MediaEntity, Models.Media>({
  $toPersistence: {},
  $toDomain: {
    UserMedias: (obj: Models.Media) => obj.UserMedias?.map((item) => Mappers.UserMediaEntityMapper.getInstance().toDomainEntity(item)) || [],
  },
});
