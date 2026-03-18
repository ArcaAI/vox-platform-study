import {
    AutoClassMapper,
    AutoEntityChangeMapper,
    BaseMapper,
    createMapperHandlers,
} from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class RoleEntityMapper extends BaseMapper<Entities.RoleEntity, Models.Role> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.RoleEntity): Models.Role {
        return AutoClassMapper(
            entity,
            Models.Role,
            RoleEntityMapperHandlers.$toPersistence,
        );
    }

    public toPersistenceChanges(entity: Entities.RoleEntity): Partial<Models.Role> {
        return AutoEntityChangeMapper(
            entity,
            Models.Role,
            RoleEntityMapperHandlers.$toPersistence,
        );
    }

    public toDomainEntity(dataModel: Models.Role): Entities.RoleEntity {
        return AutoClassMapper(
            dataModel,
            Entities.RoleEntity,
            RoleEntityMapperHandlers.$toDomain,
        );
    }
}

export const RoleEntityMapperHandlers = createMapperHandlers<Entities.RoleEntity, Models.Role>({
    $toPersistence: {
        userRoleAssignmentId: (obj: Entities.RoleEntity) => obj.UserRoleAssignment?.id || null,
    },
    $toDomain: {
        RolePermissions: (obj: Models.Role) => obj.RolePermissions?.map(item => Mappers.RolePermissionEntityMapper.getInstance().toDomainEntity(item)) || [],
        UserRoleAssignment: (obj: Models.Role) => obj.UserRoleAssignment ? Mappers.UserRoleAssignmentEntityMapper.getInstance().toDomainEntity(obj.UserRoleAssignment) : null,
    },
});