import { Injectable } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/database';

import { Repository } from '../../../common';
import { PipelinePolicyEntityMapper } from '../../../mappers';
import { PipelinePolicyEntity } from '../../../entities';
import { PipelinePolicy } from '../../../models';
import { PipelinePolicyScope } from '../../../enums';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/**
 * Editable realtime-pipeline policy repository (TASK-356 Phase 5, Pillar B).
 *
 * Polymorphic across the cascade tiers via `scope`/`scopeId`. One row per
 * (tenant, scope, scopeId); the reserved SYSTEM tenant owns the platform-default
 * TENANT row, and per-tenant / department / doctor rows override it. Like
 * `HarnessPolicyRepository`, this is a SYSTEM-shared read model, so pinning
 * `tenantId` to either the caller OR the SYSTEM tenant resolves deterministically
 * with no cross-tenant leakage. Updates go through the inherited
 * `updateWithVersion` (OCC CAS on `_version`).
 */
@Injectable()
export class PipelinePolicyRepository extends Repository<PipelinePolicyEntity, PipelinePolicy> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'pipelinePolicy', PipelinePolicyEntityMapper.getInstance());
  }

  /**
   * The single row owned EXACTLY by `(tenantId, scope, scopeId)`, or null when
   * that tier has no override yet. `scopeId` is normalized to null for the
   * TENANT tier so the `scopeId IS NULL` predicate matches the default row.
   */
  async findForScope(
    tenantId: string,
    scope: PipelinePolicyScope,
    scopeId: string | null = null,
  ): Promise<PipelinePolicyEntity | null> {
    try {
      return await this.findFirst({
        filters: { tenantId, scope, scopeId: scope === PipelinePolicyScope.TENANT ? null : scopeId },
      });
    } catch {
      return null;
    }
  }

  /** The tenant-default (scope=TENANT, scopeId=null) row, or null when unset. */
  async findTenantDefault(tenantId: string): Promise<PipelinePolicyEntity | null> {
    return this.findForScope(tenantId, PipelinePolicyScope.TENANT, null);
  }

  /** The SYSTEM-tenant platform-default row, or null when unseeded. */
  async findSystemDefault(): Promise<PipelinePolicyEntity | null> {
    return this.findTenantDefault(SYSTEM_TENANT_ID);
  }

  /**
   * The candidate override rows for one consultation's tenant, in a single
   * query: the tenant default (TENANT) plus the department/doctor overrides when
   * those ids are known. The SYSTEM platform default lives under a DIFFERENT
   * tenant id, so callers fetch it separately via `findSystemDefault()`; the
   * `ConfigResolver` walks the returned rows DOCTOR → DEPARTMENT → TENANT and
   * then falls through to the system default + code default per setting.
   */
  async findCascadeRows(params: {
    tenantId: string;
    departmentId?: string | null;
    doctorId?: string | null;
  }): Promise<PipelinePolicyEntity[]> {
    const { tenantId, departmentId, doctorId } = params;
    const or: Array<{ scope: PipelinePolicyScope; scopeId: string | null }> = [
      { scope: PipelinePolicyScope.TENANT, scopeId: null },
    ];
    if (departmentId) {
      or.push({ scope: PipelinePolicyScope.DEPARTMENT, scopeId: departmentId });
    }
    if (doctorId) {
      or.push({ scope: PipelinePolicyScope.DOCTOR, scopeId: doctorId });
    }
    return this.findAll({ filters: { tenantId }, where: { OR: or } });
  }
}
