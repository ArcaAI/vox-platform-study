import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// ServiceRelease is machine-written (self-registration) and never
// human-edited, so it is non-OCC — no `FIELDS_NOT_WRITABLE` strip is needed
// here (contrast `ChangelogEntryEntityMapper`, the one human-edited model in
// this registry).
export class ServiceReleaseEntityMapper extends BaseMapper<Entities.ServiceReleaseEntity, Models.ServiceRelease> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ServiceReleaseEntity): Models.ServiceRelease {
    return AutoClassMapper(entity, Models.ServiceRelease, ServiceReleaseEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.ServiceReleaseEntity): Partial<Models.ServiceRelease> {
    return AutoEntityChangeMapper(entity, Models.ServiceRelease, ServiceReleaseEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.ServiceRelease): Entities.ServiceReleaseEntity {
    return AutoClassMapper(dataModel, Entities.ServiceReleaseEntity, ServiceReleaseEntityMapperHandlers.$toDomain);
  }
}

export const ServiceReleaseEntityMapperHandlers = createMapperHandlers<Entities.ServiceReleaseEntity, Models.ServiceRelease>({
  $toPersistence: {},
  $toDomain: {},
});
