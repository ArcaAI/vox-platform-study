import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TenantTtsProviderCredentialEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { TenantTtsProviderCredentialEntityMapper } from '../../../mappers';
import { TenantTtsProviderCredential } from '../../../models';

@Injectable()
export class TenantTtsProviderCredentialRepository extends Repository<
  TenantTtsProviderCredentialEntity,
  TenantTtsProviderCredential
> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantTtsProviderCredential', TenantTtsProviderCredentialEntityMapper.getInstance());
  }

  /** All (non-deleted) BYO credentials configured for a tenant. */
  async findByTenantId(tenantId: string): Promise<TenantTtsProviderCredentialEntity[]> {
    return this.findAll({
      filters: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
      sort: [{ provider: 'asc' }],
    });
  }

  /** The credential row for one (tenant, provider), or null when unset. */
  async findByTenantAndProvider(
    tenantId: string,
    provider: string,
  ): Promise<TenantTtsProviderCredentialEntity | null> {
    try {
      return await this.findFirst({
        filters: { tenantId, provider, resourceStatus: ResourceStatusType.ENABLED },
      });
    } catch {
      return null;
    }
  }
}
