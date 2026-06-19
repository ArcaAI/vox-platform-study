import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

export class RoleEntityMapper extends BaseMapper<Entities.RoleEntity, Models.Role> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.RoleEntity): Models.Role {
    return AutoClassMapper(entity, Models.Role, RoleEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.RoleEntity): Partial<Models.Role> {
    return AutoEntityChangeMapper(entity, Models.Role, RoleEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.Role): Entities.RoleEntity {
    return AutoClassMapper(dataModel, Entities.RoleEntity, RoleEntityMapperHandlers.$toDomain);
  }
}

export const RoleEntityMapperHandlers = createMapperHandlers<Entities.RoleEntity, Models.Role>({
  $toPersistence: {},
  $toDomain: {
    // TASK-368 — the policy-based RBAC migration removed `RolePermissions`,
    // `UserRoleAssignment`, and `userRoleAssignmentId` from the `Role` Prisma
    // model (roles now bind via `RolePolicies` / `UserRoleAssignments`). The
    // legacy RoleEntity fields are retained for backward-compatible shape but are
    // no longer sourced from persistence, so project them to stable empties
    // instead of reading the now-removed model relations.
    RolePermissions: () => [],
    UserRoleAssignment: () => null,
  },
});
