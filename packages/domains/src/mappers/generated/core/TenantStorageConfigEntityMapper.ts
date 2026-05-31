import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

export class TenantStorageConfigEntityMapper extends BaseMapper<Entities.TenantStorageConfigEntity, Models.TenantStorageConfig> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantStorageConfigEntity): Models.TenantStorageConfig {
    return AutoClassMapper(entity, Models.TenantStorageConfig, TenantStorageConfigEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.TenantStorageConfigEntity): Partial<Models.TenantStorageConfig> {
    return AutoEntityChangeMapper(entity, Models.TenantStorageConfig, TenantStorageConfigEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.TenantStorageConfig): Entities.TenantStorageConfigEntity {
    return AutoClassMapper(dataModel, Entities.TenantStorageConfigEntity, TenantStorageConfigEntityMapperHandlers.$toDomain);
  }
}

export const TenantStorageConfigEntityMapperHandlers = createMapperHandlers<Entities.TenantStorageConfigEntity, Models.TenantStorageConfig>({
  $toPersistence: {},
  $toDomain: {},
});
