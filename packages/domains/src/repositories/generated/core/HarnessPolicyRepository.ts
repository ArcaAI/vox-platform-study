import { Injectable } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/database';

import { Repository } from '../../../common';
import { HarnessPolicyEntityMapper } from '../../../mappers';
import { HarnessPolicyEntity } from '../../../entities';
import { HarnessPolicy } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/**
 * Editable harness-policy repository (TASK-330 Phase 6).
 *
 * One row per tenant (enforced by a UNIQUE index on `tenantId`). The reserved
 * SYSTEM tenant owns the GLOBAL-DEFAULT row; a per-tenant row overrides it.
 * `HarnessPolicy` is a SYSTEM-shared read model, so the tenant-scope extension
 * permits pinning `tenantId` to either the caller OR the SYSTEM tenant — both
 * reads below resolve deterministically with no cross-tenant leakage. Updates
 * go through the inherited `updateWithVersion` (OCC CAS on `_version`).
 */
@Injectable()
export class HarnessPolicyRepository extends Repository<HarnessPolicyEntity, HarnessPolicy> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'harnessPolicy', HarnessPolicyEntityMapper.getInstance());
  }

  /**
   * The policy row owned EXACTLY by `tenantId` (no SYSTEM fallback), or null
   * when the tenant has not created its own row yet.
   */
  async findForExactTenant(tenantId: string): Promise<HarnessPolicyEntity | null> {
    try {
      return await this.findFirst({ filters: { tenantId } });
    } catch {
      return null;
    }
  }

  /** The SYSTEM-tenant GLOBAL-DEFAULT policy row, or null when unseeded. */
  async findSystemDefault(): Promise<HarnessPolicyEntity | null> {
    return this.findForExactTenant(SYSTEM_TENANT_ID);
  }

  /**
   * The ACTIVE policy for a tenant: the tenant's own row when present, else the
   * SYSTEM-tenant GLOBAL-DEFAULT row. Null only when neither exists (the
   * platform default has not been seeded).
   */
  async findActiveForTenant(tenantId: string): Promise<HarnessPolicyEntity | null> {
    const own = await this.findForExactTenant(tenantId);
    if (own) return own;
    if (tenantId === SYSTEM_TENANT_ID) return null;
    return this.findSystemDefault();
  }
}
