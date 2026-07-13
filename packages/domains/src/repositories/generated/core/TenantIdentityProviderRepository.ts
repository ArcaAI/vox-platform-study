import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TenantIdentityProviderEntity } from '../../../entities';
import { IdpProtocol, IdpStatus, ResourceStatusType } from '../../../enums';
import { TenantIdentityProviderEntityMapper } from '../../../mappers';
import { TenantIdentityProvider } from '../../../models';

@Injectable()
export class TenantIdentityProviderRepository extends Repository<
  TenantIdentityProviderEntity,
  TenantIdentityProvider
> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantIdentityProvider', TenantIdentityProviderEntityMapper.getInstance());
  }

  /** All (non-deleted) IdP configs for a tenant. */
  async findByTenantId(tenantId: string): Promise<TenantIdentityProviderEntity[]> {
    return this.findAll({
      filters: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
    });
  }

  /** The tenant's ENABLED provider for a protocol (per-tenant OIDC client resolver, D4), or null. */
  async findEnabledByTenantAndProtocol(
    tenantId: string,
    protocol: IdpProtocol,
  ): Promise<TenantIdentityProviderEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          tenantId,
          protocol,
          providerStatus: IdpStatus.ENABLED,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch {
      return null;
    }
  }
}
