import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class RolePermissionEntityMapper extends BaseMapper<Entities.RolePermissionEntity, Models.RolePermission> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.RolePermissionEntity): Models.RolePermission {
    return AutoClassMapper(entity, Models.RolePermission, RolePermissionEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.RolePermissionEntity): Partial<Models.RolePermission> {
    return AutoEntityChangeMapper(entity, Models.RolePermission, RolePermissionEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.RolePermission): Entities.RolePermissionEntity {
    return AutoClassMapper(dataModel, Entities.RolePermissionEntity, RolePermissionEntityMapperHandlers.$toDomain);
  }
}

export const RolePermissionEntityMapperHandlers = createMapperHandlers<Entities.RolePermissionEntity, Models.RolePermission>({
  $toPersistence: {
    roleId: (obj: Entities.RolePermissionEntity) => obj.Role?.id || null,
    permissionId: (obj: Entities.RolePermissionEntity) => obj.Permission?.id || null,
  },
  $toDomain: {
    Role: (obj: Models.RolePermission) => (obj.Role ? Mappers.RoleEntityMapper.getInstance().toDomainEntity(obj.Role) : null),
    Permission: (obj: Models.RolePermission) => (obj.Permission ? Mappers.PermissionEntityMapper.getInstance().toDomainEntity(obj.Permission) : null),
  },
});
