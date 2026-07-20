import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AiRuntimeProfileEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { AiRuntimeProfileEntityMapper } from '../../../mappers';
import { AiRuntimeProfile } from '../../../models';

/**
 * Runtime-profile repository (TASK-524 — config-plane core).
 *
 * HAND-AUTHORED — the `gen:repository` generator crashes pre-existingly; this
 * follows the `AiTaskDefaultRepository` precedent in this folder.
 *
 * One row per (tenant, provider, modelSlug) — enforced by the
 * `AiRuntimeProfile_tenant_provider_model_unique` index, where `modelSlug = ''`
 * is the provider-level default sentinel. Rows are SYSTEM-tenant-only in this
 * program (service-enforced). `AiRuntimeProfile` is a SYSTEM-shared read model,
 * so every tenant's injection cascade can read the SYSTEM rows; the cascade
 * itself is resolved by `AiRuntimeProfileService.resolveProfile`.
 */
@Injectable()
export class AiRuntimeProfileRepository extends Repository<AiRuntimeProfileEntity, AiRuntimeProfile> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'aiRuntimeProfile', AiRuntimeProfileEntityMapper.getInstance());
  }

  // ===== Custom Query Methods =====

  /**
   * The (tenant, provider, modelSlug) lookup driving the injection cascade.
   * Pass `modelSlug: ''` for the provider-level default row.
   *
   * Accepts an optional transaction/base client so a global admin acting on the
   * SYSTEM tenant can read through the unscoped lane — without it the
   * tenant-scope extension injects the admin's working tenant and the read
   * silently misses.
   */
  async findByTenantProviderAndModel(
    tenantId: string,
    provider: string,
    modelSlug: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiRuntimeProfileEntity | null> {
    const where = { tenantId, provider, modelSlug, resourceStatus: ResourceStatusType.ENABLED };

    if (tx) {
      const model = await (tx as Record<string, any>).aiRuntimeProfile.findFirst({ where });
      return model ? AiRuntimeProfileEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where });
    } catch (err) {
      // Only a genuine miss maps to null — a tenant-scope mismatch must SURFACE
      // rather than read as "no profile" (r2605 Finding A).
      if (err instanceof DataNotFoundException) return null;
      throw err;
    }
  }

  /** Every ENABLED profile row for one tenant (admin list). */
  async findByTenantId(
    tenantId: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiRuntimeProfileEntity[]> {
    const where = { tenantId, resourceStatus: ResourceStatusType.ENABLED };

    if (tx) {
      const models = await (tx as Record<string, any>).aiRuntimeProfile.findMany({
        where,
        orderBy: [{ provider: 'asc' }, { modelSlug: 'asc' }],
      });
      const mapper = AiRuntimeProfileEntityMapper.getInstance();
      return models.map((m: any) => mapper.toDomainEntity(m));
    }

    return this.findAll({ filters: where, sort: [{ provider: 'asc' }, { modelSlug: 'asc' }] });
  }
}
