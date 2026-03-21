import {
    AutoClassMapper,
    AutoEntityChangeMapper,
    BaseMapper,
    createMapperHandlers,
} from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class UserRoleAssignmentEntityMapper extends BaseMapper<Entities.UserRoleAssignmentEntity, Models.UserRoleAssignment> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.UserRoleAssignmentEntity): Models.UserRoleAssignment {
        return AutoClassMapper(
            entity,
            Models.UserRoleAssignment,
            UserRoleAssignmentEntityMapperHandlers.$toPersistence,
        );
    }

    public toPersistenceChanges(entity: Entities.UserRoleAssignmentEntity): Partial<Models.UserRoleAssignment> {
        return AutoEntityChangeMapper(
            entity,
            Models.UserRoleAssignment,
            UserRoleAssignmentEntityMapperHandlers.$toPersistence,
        );
    }

    public toDomainEntity(dataModel: Models.UserRoleAssignment): Entities.UserRoleAssignmentEntity {
        return AutoClassMapper(
            dataModel,
            Entities.UserRoleAssignmentEntity,
            UserRoleAssignmentEntityMapperHandlers.$toDomain,
        );
    }
}

export const UserRoleAssignmentEntityMapperHandlers = createMapperHandlers<Entities.UserRoleAssignmentEntity, Models.UserRoleAssignment>({
    $toPersistence: {
        userId: (obj: Entities.UserRoleAssignmentEntity) => obj.userId,
        roleId: (obj: Entities.UserRoleAssignmentEntity) => obj.roleId,
    },
    $toDomain: {
        userId: (obj: Models.UserRoleAssignment) => obj.userId,
        roleId: (obj: Models.UserRoleAssignment) => obj.roleId,
        User: (obj: Models.UserRoleAssignment) => obj.User ? Mappers.UserEntityMapper.getInstance().toDomainEntity(obj.User) : null,
        Roles: (obj: Models.UserRoleAssignment) => obj.Roles?.map(item => Mappers.RoleEntityMapper.getInstance().toDomainEntity(item)) || [],
    },
});