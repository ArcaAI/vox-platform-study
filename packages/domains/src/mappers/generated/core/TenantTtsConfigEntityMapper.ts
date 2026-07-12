import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

export class TenantTtsConfigEntityMapper extends BaseMapper<Entities.TenantTtsConfigEntity, Models.TenantTtsConfig> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantTtsConfigEntity): Models.TenantTtsConfig {
    return AutoClassMapper(entity, Models.TenantTtsConfig, TenantTtsConfigEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.TenantTtsConfigEntity): Partial<Models.TenantTtsConfig> {
    return AutoEntityChangeMapper(entity, Models.TenantTtsConfig, TenantTtsConfigEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.TenantTtsConfig): Entities.TenantTtsConfigEntity {
    return AutoClassMapper(dataModel, Entities.TenantTtsConfigEntity, TenantTtsConfigEntityMapperHandlers.$toDomain);
  }
}

export const TenantTtsConfigEntityMapperHandlers = createMapperHandlers<Entities.TenantTtsConfigEntity, Models.TenantTtsConfig>({
  $toPersistence: {},
  $toDomain: {},
});
