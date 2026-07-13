import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

export class FederatedIdentityEntityMapper extends BaseMapper<
  Entities.FederatedIdentityEntity,
  Models.FederatedIdentity
> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.FederatedIdentityEntity): Models.FederatedIdentity {
    return AutoClassMapper(entity, Models.FederatedIdentity, FederatedIdentityEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.FederatedIdentityEntity): Partial<Models.FederatedIdentity> {
    return AutoEntityChangeMapper(
      entity,
      Models.FederatedIdentity,
      FederatedIdentityEntityMapperHandlers.$toPersistence,
    );
  }

  public toDomainEntity(dataModel: Models.FederatedIdentity): Entities.FederatedIdentityEntity {
    return AutoClassMapper(
      dataModel,
      Entities.FederatedIdentityEntity,
      FederatedIdentityEntityMapperHandlers.$toDomain,
    );
  }
}

export const FederatedIdentityEntityMapperHandlers = createMapperHandlers<
  Entities.FederatedIdentityEntity,
  Models.FederatedIdentity
>({
  $toPersistence: {},
  $toDomain: {},
});
