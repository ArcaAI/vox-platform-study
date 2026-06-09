import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

export class HighlightEntityMapper extends BaseMapper<Entities.HighlightEntity, Models.Highlight> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.HighlightEntity): Models.Highlight {
    return AutoClassMapper(entity, Models.Highlight, HighlightEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.HighlightEntity): Partial<Models.Highlight> {
    return AutoEntityChangeMapper(entity, Models.Highlight, HighlightEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.Highlight): Entities.HighlightEntity {
    return AutoClassMapper(dataModel, Entities.HighlightEntity, HighlightEntityMapperHandlers.$toDomain);
  }
}

export const HighlightEntityMapperHandlers = createMapperHandlers<Entities.HighlightEntity, Models.Highlight>({
  $toPersistence: {},
  $toDomain: {},
});
