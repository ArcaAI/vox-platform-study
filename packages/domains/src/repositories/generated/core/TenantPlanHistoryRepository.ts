import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TenantPlanHistoryEntity } from '../../../entities';
import { TenantPlanHistoryEntityMapper } from '../../../mappers';
import { TenantPlanHistory } from '../../../models';

/**
 * Append-only plan-history repository — the invoice engine's plan-fee basis.
 *
 * Posture mirrors `AiUsageEventRepository`: the model is in
 * MODELS_WITHOUT_SOFT_DELETE and has no `resourceStatus` column, so
 * `softDelete()`/`restore()` throw; and writes emit no sys-events (the plan
 * change broadcasts on the Tenant it mutates). A wrong window is corrected by
 * closing it and appending a `correction` row, never by deletion.
 *
 * Cross-tenant isolation is enforced upstream by the shared tenant-scope
 * `$extends`; every finder here is additionally scoped by an explicit
 * `tenantId` filter.
 */
@Injectable()
export class TenantPlanHistoryRepository extends Repository<TenantPlanHistoryEntity, TenantPlanHistory> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantPlanHistory', TenantPlanHistoryEntityMapper.getInstance());
  }

  /**
   * The window still in force for a tenant, or null.
   *
   * "Open" is `effectiveTo: null` — the plane's single marker for "current".
   * A tenant with no plan has no open row (D3: absence means no plan fee), so
   * null is a legitimate answer, never an error.
   */
  async findOpenWindow(tenantId: string): Promise<TenantPlanHistoryEntity | null> {
    const model = await this.db.findFirst({
      where: { tenantId, effectiveTo: null },
      orderBy: [{ effectiveFrom: 'desc' }],
    });
    return model ? TenantPlanHistoryEntityMapper.getInstance().toDomainEntity(model) : null;
  }

  /**
   * Every window OVERLAPPING [from, to), ordered by start.
   *
   * Overlap — not containment — is what proration needs: a plan held across the
   * whole period has a window that starts before `from` and ends after `to`, so
   * a containment filter would return nothing and silently drop the plan fee.
   * Half-open on both sides so consecutive periods neither double-count a
   * boundary window nor drop one.
   */
  async findOverlappingPeriod(tenantId: string, from: Date, to: Date): Promise<TenantPlanHistoryEntity[]> {
    const models = await this.db.findMany({
      where: {
        tenantId,
        effectiveFrom: { lt: to },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: from } }],
      },
      orderBy: [{ effectiveFrom: 'asc' }],
    });
    const mapper = TenantPlanHistoryEntityMapper.getInstance();
    return models.map((model: TenantPlanHistory) => mapper.toDomainEntity(model));
  }
}
