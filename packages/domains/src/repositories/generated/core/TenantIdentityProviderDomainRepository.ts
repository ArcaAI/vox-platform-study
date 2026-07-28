import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TenantIdentityProviderDomainEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { TenantIdentityProviderDomainEntityMapper } from '../../../mappers';
import { TenantIdentityProviderDomain } from '../../../models';

@Injectable()
export class TenantIdentityProviderDomainRepository extends Repository<TenantIdentityProviderDomainEntity, TenantIdentityProviderDomain> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantIdentityProviderDomain', TenantIdentityProviderDomainEntityMapper.getInstance());
  }

  /** The provider a verified email domain routes to (HRD lookup, D5), or null when unmapped. */
  async findByDomain(domain: string): Promise<TenantIdentityProviderDomainEntity | null> {
    try {
      return await this.findFirst({
        filters: { domain, resourceStatus: ResourceStatusType.ENABLED },
      });
    } catch {
      return null;
    }
  }
}
