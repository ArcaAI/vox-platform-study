import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class ContextItemVersionEntityMapper extends BaseMapper<Entities.ContextItemVersionEntity, Models.ContextItemVersion> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ContextItemVersionEntity): Models.ContextItemVersion {
    const model = AutoClassMapper(entity, Models.ContextItemVersion, ContextItemVersionEntityMapperHandlers.$toPersistence);
    const raw = model as unknown as Record<string, unknown>;
    delete raw.createdBy;
    delete raw.updatedBy;
    delete raw.updatedAt;
    delete raw.version;
    delete raw.resourceStatus;
    delete raw.resourceStatusUpdatedAt;
    delete raw.resourceStatusUpdatedBy;
    return model;
  }

  public toPersistenceChanges(entity: Entities.ContextItemVersionEntity): Partial<Models.ContextItemVersion> {
    const model = AutoEntityChangeMapper(entity, Models.ContextItemVersion, ContextItemVersionEntityMapperHandlers.$toPersistence);
    const raw = model as unknown as Record<string, unknown>;
    delete raw.createdBy;
    delete raw.updatedBy;
    delete raw.updatedAt;
    delete raw.version;
    delete raw.resourceStatus;
    delete raw.resourceStatusUpdatedAt;
    delete raw.resourceStatusUpdatedBy;
    return model;
  }

  public toDomainEntity(dataModel: Models.ContextItemVersion): Entities.ContextItemVersionEntity {
    return AutoClassMapper(dataModel, Entities.ContextItemVersionEntity, ContextItemVersionEntityMapperHandlers.$toDomain);
  }
}

export const ContextItemVersionEntityMapperHandlers = createMapperHandlers<Entities.ContextItemVersionEntity, Models.ContextItemVersion>({
  $toPersistence: {},
  $toDomain: {},
});
