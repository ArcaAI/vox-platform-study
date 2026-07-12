import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

export class TenantTtsProviderCredentialEntityMapper extends BaseMapper<
  Entities.TenantTtsProviderCredentialEntity,
  Models.TenantTtsProviderCredential
> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantTtsProviderCredentialEntity): Models.TenantTtsProviderCredential {
    return AutoClassMapper(
      entity,
      Models.TenantTtsProviderCredential,
      TenantTtsProviderCredentialEntityMapperHandlers.$toPersistence,
    );
  }

  public toPersistenceChanges(
    entity: Entities.TenantTtsProviderCredentialEntity,
  ): Partial<Models.TenantTtsProviderCredential> {
    return AutoEntityChangeMapper(
      entity,
      Models.TenantTtsProviderCredential,
      TenantTtsProviderCredentialEntityMapperHandlers.$toPersistence,
    );
  }

  public toDomainEntity(dataModel: Models.TenantTtsProviderCredential): Entities.TenantTtsProviderCredentialEntity {
    return AutoClassMapper(
      dataModel,
      Entities.TenantTtsProviderCredentialEntity,
      TenantTtsProviderCredentialEntityMapperHandlers.$toDomain,
    );
  }
}

export const TenantTtsProviderCredentialEntityMapperHandlers = createMapperHandlers<
  Entities.TenantTtsProviderCredentialEntity,
  Models.TenantTtsProviderCredential
>({
  $toPersistence: {},
  $toDomain: {},
});
