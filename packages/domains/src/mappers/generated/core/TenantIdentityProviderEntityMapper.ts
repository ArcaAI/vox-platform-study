import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

export class TenantIdentityProviderEntityMapper extends BaseMapper<
  Entities.TenantIdentityProviderEntity,
  Models.TenantIdentityProvider
> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantIdentityProviderEntity): Models.TenantIdentityProvider {
    return AutoClassMapper(
      entity,
      Models.TenantIdentityProvider,
      TenantIdentityProviderEntityMapperHandlers.$toPersistence,
    );
  }

  public toPersistenceChanges(
    entity: Entities.TenantIdentityProviderEntity,
  ): Partial<Models.TenantIdentityProvider> {
    return AutoEntityChangeMapper(
      entity,
      Models.TenantIdentityProvider,
      TenantIdentityProviderEntityMapperHandlers.$toPersistence,
    );
  }

  public toDomainEntity(dataModel: Models.TenantIdentityProvider): Entities.TenantIdentityProviderEntity {
    return AutoClassMapper(
      dataModel,
      Entities.TenantIdentityProviderEntity,
      TenantIdentityProviderEntityMapperHandlers.$toDomain,
    );
  }
}

export const TenantIdentityProviderEntityMapperHandlers = createMapperHandlers<
  Entities.TenantIdentityProviderEntity,
  Models.TenantIdentityProvider
>({
  $toPersistence: {},
  $toDomain: {},
});
