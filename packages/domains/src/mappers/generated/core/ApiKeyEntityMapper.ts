import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class ApiKeyEntityMapper extends BaseMapper<Entities.ApiKeyEntity, Models.ApiKey> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ApiKeyEntity): Models.ApiKey {
    return AutoClassMapper(entity, Models.ApiKey, ApiKeyEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.ApiKeyEntity): Partial<Models.ApiKey> {
    return AutoEntityChangeMapper(entity, Models.ApiKey, ApiKeyEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.ApiKey): Entities.ApiKeyEntity {
    return AutoClassMapper(dataModel, Entities.ApiKeyEntity, ApiKeyEntityMapperHandlers.$toDomain);
  }
}

export const ApiKeyEntityMapperHandlers = createMapperHandlers<Entities.ApiKeyEntity, Models.ApiKey>({
  $toPersistence: {},
  $toDomain: {},
});
