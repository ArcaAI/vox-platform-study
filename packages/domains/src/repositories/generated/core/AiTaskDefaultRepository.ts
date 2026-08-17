import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AiTaskDefaultEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { AiTaskDefaultEntityMapper } from '../../../mappers';
import { AiTaskDefault } from '../../../models';

/**
 * Per-tenant "default model for task X" repository.
 *
 * One row per (tenant, taskKey) — enforced by the
 * `AiTaskDefault_tenant_task_unique` index. The reserved SYSTEM tenant row is
 * the platform default. `AiTaskDefault` is a SYSTEM-shared read model, so the
 * tenant-scope extension permits pinning `tenantId` to either the caller OR
 * the SYSTEM tenant (mirrors `HarnessPolicyRepository`); the tenant → SYSTEM
 * cascade itself is resolved by `AiTaskDefaultService.getEffective`.
 */
@Injectable()
export class AiTaskDefaultRepository extends Repository<AiTaskDefaultEntity, AiTaskDefault> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'aiTaskDefault', AiTaskDefaultEntityMapper.getInstance());
  }

  /**
   * The row owned EXACTLY by `(tenantId, taskKey)` (no SYSTEM fallback),
   * ENABLED only, or null when the tenant has no row for the task yet. When a
   * transaction client is supplied the read participates in the caller's
   * `$transaction` (mirrors the `create(..., tx)` / `updateWithVersion(..., tx)`
   * contract).
   */
  async findByTenantAndTaskKey(tenantId: string, taskKey: string, tx?: Prisma.TransactionClient | any): Promise<AiTaskDefaultEntity | null> {
    const where = { tenantId, taskKey, resourceStatus: ResourceStatusType.ENABLED };

    if (tx) {
      const model = await (tx as Record<string, any>).aiTaskDefault.findFirst({ where });
      return model ? AiTaskDefaultEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where });
    } catch (err) {
      // r2605 Finding A — only a genuine miss maps to null. Anything else
      // (most importantly the tenant-scope extension's `TenantScope: tenantId
      // mismatch` throw on a cross-tenant read) must SURFACE: the former
      // blanket catch made super-admin reads targeting SYSTEM/foreign
      // tenants silently "succeed" as empty.
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }
}
