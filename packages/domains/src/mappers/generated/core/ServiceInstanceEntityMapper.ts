import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// ServiceInstance is machine-written (self-registration + 5-minute
// heartbeats updating only `lastSeenAt`) and never human-edited, so it is
// non-OCC — no `FIELDS_NOT_WRITABLE` strip is needed (contrast
// `ChangelogEntryEntityMapper`, the one human-edited model in this registry).
export class ServiceInstanceEntityMapper extends BaseMapper<Entities.ServiceInstanceEntity, Models.ServiceInstance> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ServiceInstanceEntity): Models.ServiceInstance {
    return AutoClassMapper(entity, Models.ServiceInstance, ServiceInstanceEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.ServiceInstanceEntity): Partial<Models.ServiceInstance> {
    return AutoEntityChangeMapper(entity, Models.ServiceInstance, ServiceInstanceEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.ServiceInstance): Entities.ServiceInstanceEntity {
    return AutoClassMapper(dataModel, Entities.ServiceInstanceEntity, ServiceInstanceEntityMapperHandlers.$toDomain);
  }
}

export const ServiceInstanceEntityMapperHandlers = createMapperHandlers<Entities.ServiceInstanceEntity, Models.ServiceInstance>({
  $toPersistence: {},
  $toDomain: {},
});
