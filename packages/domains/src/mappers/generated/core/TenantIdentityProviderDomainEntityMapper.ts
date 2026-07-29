import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

export class TenantIdentityProviderDomainEntityMapper extends BaseMapper<
  Entities.TenantIdentityProviderDomainEntity,
  Models.TenantIdentityProviderDomain
> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantIdentityProviderDomainEntity): Models.TenantIdentityProviderDomain {
    return AutoClassMapper(entity, Models.TenantIdentityProviderDomain, TenantIdentityProviderDomainEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.TenantIdentityProviderDomainEntity): Partial<Models.TenantIdentityProviderDomain> {
    return AutoEntityChangeMapper(entity, Models.TenantIdentityProviderDomain, TenantIdentityProviderDomainEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.TenantIdentityProviderDomain): Entities.TenantIdentityProviderDomainEntity {
    return AutoClassMapper(dataModel, Entities.TenantIdentityProviderDomainEntity, TenantIdentityProviderDomainEntityMapperHandlers.$toDomain);
  }
}

export const TenantIdentityProviderDomainEntityMapperHandlers = createMapperHandlers<
  Entities.TenantIdentityProviderDomainEntity,
  Models.TenantIdentityProviderDomain
>({
  $toPersistence: {},
  $toDomain: {},
});
