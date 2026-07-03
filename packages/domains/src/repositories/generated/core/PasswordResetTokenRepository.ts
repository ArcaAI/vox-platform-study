import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { PasswordResetTokenEntityMapper } from '../../../mappers';
import { PasswordResetTokenEntity } from '../../../entities';
import { PasswordResetToken } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class PasswordResetTokenRepository extends Repository<PasswordResetTokenEntity, PasswordResetToken> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'passwordResetToken', PasswordResetTokenEntityMapper.getInstance());
  }

  /**
   * TASK-400 — resolve a presented token by its SHA-256 hash. Returns `null`
   * on a miss (the service maps every failure mode to one generic 400 so no
   * state is leaked). State checks (used/revoked/expired) live on the entity.
   */
  async findByTokenHash(tokenHash: string): Promise<PasswordResetTokenEntity | null> {
    try {
      return await this.findFirst({ filters: { tokenHash } });
    } catch {
      return null;
    }
  }

  /**
   * TASK-400 — every not-yet-consumed, not-yet-revoked token for a user
   * (expiry is intentionally NOT filtered here: revoking an already-expired
   * token is harmless and keeps the revocation sweep simple). Used by the
   * issue path to revoke prior active tokens (UPDATE `revokedAt`, never DELETE).
   */
  async findActiveForUser(userId: string): Promise<PasswordResetTokenEntity[]> {
    return this.findAll({ filters: { userId, usedAt: null, revokedAt: null } });
  }
}
