import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { UserEntity } from '../../../entities';
import { UserEntityMapper } from '../../../mappers';
import { User } from '../../../models';
import { ResourceStatusType } from '../../../enums';

const USER_INCLUDES = {
  UserProfile: true,
  UserRoleAssignments: {
    where: { resourceStatus: { not: ResourceStatusType.DELETED } },
    include: { Role: true },
  },
} as const;

@Injectable()
export class UserRepository extends Repository<UserEntity, User> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'user', UserEntityMapper.getInstance(), USER_INCLUDES, ['username', 'externalId']);
  }

  /**
   * Username lookup that is case-insensitive (usernames default to the admin's
   * email, and people type an email in whatever case they like) while
   * `User.username` is only case-sensitively unique. An EXACT-case match wins,
   * so legacy case-variant twins stay independently reachable; only a miss falls
   * back to a case-insensitive match. Returns null on a miss; a real database
   * error propagates.
   */
  async findByUsername(username: string, opts: { resourceStatus?: ResourceStatusType } = {}): Promise<UserEntity | null> {
    const status = opts.resourceStatus ? { resourceStatus: opts.resourceStatus } : {};
    const mapper = UserEntityMapper.getInstance();

    const exact = await this.db.findFirst({ where: { username, ...status }, include: USER_INCLUDES });
    if (exact) return mapper.toDomainEntity(exact);

    const insensitive = await this.db.findFirst({
      where: { username: { equals: username, mode: 'insensitive' }, ...status },
      include: USER_INCLUDES,
    });
    return insensitive ? mapper.toDomainEntity(insensitive) : null;
  }
}
