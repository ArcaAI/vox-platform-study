import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AiRoutingPolicyEntity } from '../../../entities';
import { AiRoutingPolicyStatus, ResourceStatusType } from '../../../enums';
import { AiRoutingPolicyEntityMapper } from '../../../mappers';
import { AiRoutingPolicy } from '../../../models';

/**
 * Provider routing policies (TASK-818 §3A.3).
 *
 * One row per (tenant, taskKey, policyVersion) — enforced by the
 * `AiRoutingPolicy_tenantId_taskKey_policyVersion_unique` index. The reserved
 * SYSTEM tenant row is the platform default. `AiRoutingPolicy` is a
 * SYSTEM-shared read model, so the tenant-scope extension permits pinning
 * `tenantId` to either the caller OR the SYSTEM tenant (mirrors
 * `AiTaskDefaultRepository`); the tenant → SYSTEM cascade itself, the
 * most-specific-match rules and the §3A.4 gates are resolved in the
 * application service, not here.
 */
@Injectable()
export class AiRoutingPolicyRepository extends Repository<AiRoutingPolicyEntity, AiRoutingPolicy> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'aiRoutingPolicy', AiRoutingPolicyEntityMapper.getInstance());
  }

  /**
   * The ACTIVE policy owned EXACTLY by `(tenantId, taskKey)` (no SYSTEM
   * fallback — the caller owns the cascade), ENABLED only, or null when that
   * tenant has authored no live policy for the task.
   *
   * Highest `policyVersion` wins: the supersede-only lifecycle can leave more
   * than one ACTIVE row addressable during a promotion, and the newest
   * authored revision is the one that serves. When a transaction client is
   * supplied the read participates in the caller's `$transaction` (mirrors the
   * `create(..., tx)` / `updateWithVersion(..., tx)` contract).
   */
  async findActiveByTenantAndTaskKey(tenantId: string, taskKey: string, tx?: Prisma.TransactionClient | any): Promise<AiRoutingPolicyEntity | null> {
    const where = {
      tenantId,
      taskKey,
      status: AiRoutingPolicyStatus.ACTIVE,
      resourceStatus: ResourceStatusType.ENABLED,
    };
    // `IFindAllProps.sort` is an ARRAY of single-key order clauses; the raw
    // Prisma `orderBy` on the tx path takes the object form.
    const sort = [{ policyVersion: 'desc' as const }];

    if (tx) {
      const model = await (tx as Record<string, any>).aiRoutingPolicy.findFirst({ where, orderBy: { policyVersion: 'desc' } });
      return model ? AiRoutingPolicyEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where, sort });
    } catch (err) {
      // Only a genuine miss maps to null. Anything else — most importantly the
      // tenant-scope extension's `TenantScope: tenantId mismatch` throw on a
      // cross-tenant read — must SURFACE rather than look like "no policy",
      // which would silently fail the request open to the SYSTEM default.
      // Same reasoning as `AiTaskDefaultRepository.findByTenantAndTaskKey`.
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }
}
