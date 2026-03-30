import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

export class StorageAccessKeyEntityMapper extends BaseMapper<Entities.StorageAccessKeyEntity, Models.StorageAccessKey> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.StorageAccessKeyEntity): Models.StorageAccessKey {
    return AutoClassMapper(entity, Models.StorageAccessKey, StorageAccessKeyEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.StorageAccessKeyEntity): Partial<Models.StorageAccessKey> {
    return AutoEntityChangeMapper(entity, Models.StorageAccessKey, StorageAccessKeyEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.StorageAccessKey): Entities.StorageAccessKeyEntity {
    return AutoClassMapper(dataModel, Entities.StorageAccessKeyEntity, StorageAccessKeyEntityMapperHandlers.$toDomain);
  }
}

export const StorageAccessKeyEntityMapperHandlers = createMapperHandlers<Entities.StorageAccessKeyEntity, Models.StorageAccessKey>({
  $toPersistence: {},
  $toDomain: {},
});
