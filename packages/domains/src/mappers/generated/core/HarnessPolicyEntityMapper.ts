import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class HarnessPolicyEntityMapper extends BaseMapper<Entities.HarnessPolicyEntity, Models.HarnessPolicy> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.HarnessPolicyEntity): Models.HarnessPolicy {
    return AutoClassMapper(entity, Models.HarnessPolicy, HarnessPolicyEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.HarnessPolicyEntity): Partial<Models.HarnessPolicy> {
    return AutoEntityChangeMapper(entity, Models.HarnessPolicy, HarnessPolicyEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.HarnessPolicy): Entities.HarnessPolicyEntity {
    return AutoClassMapper(dataModel, Entities.HarnessPolicyEntity, HarnessPolicyEntityMapperHandlers.$toDomain);
  }
}

export const HarnessPolicyEntityMapperHandlers = createMapperHandlers<Entities.HarnessPolicyEntity, Models.HarnessPolicy>({
  $toPersistence: {},
  $toDomain: {},
});
