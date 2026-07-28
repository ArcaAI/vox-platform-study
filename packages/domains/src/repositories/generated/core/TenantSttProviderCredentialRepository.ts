import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TenantSttProviderCredentialEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { TenantSttProviderCredentialEntityMapper } from '../../../mappers';
import { TenantSttProviderCredential } from '../../../models';

@Injectable()
export class TenantSttProviderCredentialRepository extends Repository<
  TenantSttProviderCredentialEntity,
  TenantSttProviderCredential
> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantSttProviderCredential', TenantSttProviderCredentialEntityMapper.getInstance());
  }

  /** All (non-deleted) BYO credentials configured for a tenant. */
  async findByTenantId(tenantId: string): Promise<TenantSttProviderCredentialEntity[]> {
    return this.findAll({
      filters: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
      sort: [{ provider: 'asc' }],
    });
  }

  /** The credential row for one (tenant, provider), or null when unset. */
  async findByTenantAndProvider(
    tenantId: string,
    provider: string,
  ): Promise<TenantSttProviderCredentialEntity | null> {
    try {
      return await this.findFirst({
        filters: { tenantId, provider, resourceStatus: ResourceStatusType.ENABLED },
      });
    } catch {
      return null;
    }
  }
}
