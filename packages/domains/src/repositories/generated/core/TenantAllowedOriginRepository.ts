import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TenantAllowedOriginEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { TenantAllowedOriginEntityMapper } from '../../../mappers';
import { TenantAllowedOrigin } from '../../../models';

/**
 * TASK-610 CORS control plane — one row per registered origin.
 *
 * HAND-AUTHORED — `gen:repository` is broken (fails on a bad argument); this
 * follows the `AiProviderConnectionRepository` / `TenantSttConfigRepository`
 * precedent in this folder.
 *
 * `origin` is GLOBALLY unique (`TenantAllowedOrigin_origin_unique`), not
 * scoped per tenant — two tenants cannot claim the same origin, because the
 * runtime reverse index (`Map<origin, ownerTenantId>` built by
 * `OriginRegistryService`) would otherwise be ambiguous about which tenant a
 * request from that origin belongs to. `findByOrigin` therefore takes no
 * `tenantId` — it is the lookup the uniqueness check and the registry rebuild
 * both need.
 */
@Injectable()
export class TenantAllowedOriginRepository extends Repository<TenantAllowedOriginEntity, TenantAllowedOrigin> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantAllowedOrigin', TenantAllowedOriginEntityMapper.getInstance());
  }

  /**
   * Exact-match lookup by the normalized origin string, ENABLED rows only.
   * Used both for the pre-create uniqueness check (a duplicate origin must be
   * rejected with a clear error rather than surfacing as a bare Prisma unique
   * constraint violation) and by callers that need a single row rather than
   * the full registry rebuild.
   */
  async findByOrigin(origin: string, tx?: Prisma.TransactionClient | any): Promise<TenantAllowedOriginEntity | null> {
    const where = { origin, resourceStatus: ResourceStatusType.ENABLED };

    if (tx) {
      const model = await (tx as Record<string, any>).tenantAllowedOrigin.findFirst({ where });
      return model ? TenantAllowedOriginEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where });
    } catch (err) {
      if (err instanceof DataNotFoundException) return null;
      throw err;
    }
  }
}
