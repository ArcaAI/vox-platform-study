import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { FederatedIdentityEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { FederatedIdentityEntityMapper } from '../../../mappers';
import { FederatedIdentity } from '../../../models';

@Injectable()
export class FederatedIdentityRepository extends Repository<FederatedIdentityEntity, FederatedIdentity> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'federatedIdentity', FederatedIdentityEntityMapper.getInstance());
  }

  /** The link for a given (providerId, subject) — the JIT/login-time lookup — or null when unprovisioned. */
  async findByProviderAndSubject(providerId: string, subject: string): Promise<FederatedIdentityEntity | null> {
    try {
      return await this.findFirst({
        filters: { providerId, subject, resourceStatus: ResourceStatusType.ENABLED },
      });
    } catch {
      return null;
    }
  }

  /** All (non-deleted) federated links for a HOPE user, across every provider they federate with. */
  async findByUserId(userId: string): Promise<FederatedIdentityEntity[]> {
    return this.findAll({
      filters: { userId, resourceStatus: ResourceStatusType.ENABLED },
    });
  }
}
