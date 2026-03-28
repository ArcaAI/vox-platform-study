import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class TagEntityMapper extends BaseMapper<Entities.TagEntity, Models.Tag> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TagEntity): Models.Tag {
    return AutoClassMapper(entity, Models.Tag, TagEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.TagEntity): Partial<Models.Tag> {
    return AutoEntityChangeMapper(entity, Models.Tag, TagEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.Tag): Entities.TagEntity {
    return AutoClassMapper(dataModel, Entities.TagEntity, TagEntityMapperHandlers.$toDomain);
  }
}

export const TagEntityMapperHandlers = createMapperHandlers<Entities.TagEntity, Models.Tag>({
  $toPersistence: {},
  $toDomain: {},
});
