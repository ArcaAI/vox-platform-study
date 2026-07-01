import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { PlanEntitlementEntityMapper } from '../../../mappers';
import { PlanEntitlementEntity } from '../../../entities';
import { PlanEntitlement } from '../../../models';
import { TenantPlan } from '../../../enums';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class PlanEntitlementRepository extends Repository<PlanEntitlementEntity, PlanEntitlement> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'planEntitlement', PlanEntitlementEntityMapper.getInstance());
  }

  /**
   * TASK-392 (Q1) — resolve the single default-matrix row for a commercial
   * plan (`plan` is `@unique`). Returns `null` when no row is seeded yet so
   * the resolver can fall back to the seeded-constant baseline.
   */
  async findByPlan(plan: TenantPlan): Promise<PlanEntitlementEntity | null> {
    try {
      return await this.findFirst({ filters: { plan } });
    } catch {
      return null;
    }
  }
}
