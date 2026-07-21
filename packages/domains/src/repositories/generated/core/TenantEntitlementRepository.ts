import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { TenantEntitlementEntityMapper } from '../../../mappers';
import { TenantEntitlementEntity } from '../../../entities';
import { TenantEntitlement } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class TenantEntitlementRepository extends Repository<TenantEntitlementEntity, TenantEntitlement> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantEntitlement', TenantEntitlementEntityMapper.getInstance());
  }

  /**
   * Resolve the single per-tenant override row (`tenantId`
   * is `@unique`). Returns `null` when the tenant has no override yet, so the
   * resolver can fall back to the plan default matrix.
   */
  async findByTenant(tenantId: string): Promise<TenantEntitlementEntity | null> {
    try {
      return await this.findFirst({ filters: { tenantId } });
    } catch {
      return null;
    }
  }
}
