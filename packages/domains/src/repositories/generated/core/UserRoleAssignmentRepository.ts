import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { UserRoleAssignmentEntityMapper } from '../../../mappers';
import { UserRoleAssignmentEntity } from '../../../entities';
import { UserRoleAssignment } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

// Eager-load the Role relation so the DTO layer can surface
// `roleName` (the admin console renders role names, not raw UUIDs). The mapper
// projects the singular `Role` relation into the entity's `Roles` array; `User`
// is intentionally NOT included (unneeded here and heavy). Repositories carry no
// CI drift gate; hand-maintained includes mirror `UserRepository`'s precedent.
const USER_ROLE_ASSIGNMENT_INCLUDES = { Role: true } as const;

@Injectable()
export class UserRoleAssignmentRepository extends Repository<UserRoleAssignmentEntity, UserRoleAssignment> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'userRoleAssignment', UserRoleAssignmentEntityMapper.getInstance(), USER_ROLE_ASSIGNMENT_INCLUDES);
  }
}
