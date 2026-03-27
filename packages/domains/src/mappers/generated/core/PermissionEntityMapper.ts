import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class PermissionEntityMapper extends BaseMapper<Entities.PermissionEntity, Models.Permission> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.PermissionEntity): Models.Permission {
    return AutoClassMapper(entity, Models.Permission, PermissionEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.PermissionEntity): Partial<Models.Permission> {
    return AutoEntityChangeMapper(entity, Models.Permission, PermissionEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.Permission): Entities.PermissionEntity {
    return AutoClassMapper(dataModel, Entities.PermissionEntity, PermissionEntityMapperHandlers.$toDomain);
  }
}

export const PermissionEntityMapperHandlers = createMapperHandlers<Entities.PermissionEntity, Models.Permission>({
  $toPersistence: {},
  $toDomain: {
    RolePermissions: (obj: Models.Permission) =>
      obj.RolePermissions?.map((item) => Mappers.RolePermissionEntityMapper.getInstance().toDomainEntity(item)) || [],
  },
});
