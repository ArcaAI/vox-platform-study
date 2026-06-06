import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class GoldenSetEntityMapper extends BaseMapper<Entities.GoldenSetEntity, Models.GoldenSet> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.GoldenSetEntity): Models.GoldenSet {
    return AutoClassMapper(entity, Models.GoldenSet, GoldenSetEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.GoldenSetEntity): Partial<Models.GoldenSet> {
    return AutoEntityChangeMapper(entity, Models.GoldenSet, GoldenSetEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.GoldenSet): Entities.GoldenSetEntity {
    return AutoClassMapper(dataModel, Entities.GoldenSetEntity, GoldenSetEntityMapperHandlers.$toDomain);
  }
}

export const GoldenSetEntityMapperHandlers = createMapperHandlers<Entities.GoldenSetEntity, Models.GoldenSet>({
  $toPersistence: {},
  $toDomain: {},
});
