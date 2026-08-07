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
 * TASK-610 CORS control plane — one row per (origin, tenant) GRANT.
 *
 * HAND-AUTHORED — `gen:repository` is broken (fails on a bad argument); this
 * follows the `AiProviderConnectionRepository` / `TenantSttConfigRepository`
 * precedent in this folder.
 *
 * §4B superseded single ownership: an origin does not belong to exactly one
 * tenant, it grants a SET of tenants permission to act on it. Uniqueness is
 * therefore scoped to the (origin, tenantId) PAIR (`TenantAllowedOrigin_origin_tenantId_unique`)
 * — the same tenant cannot register the same origin twice, but two different
 * tenants sharing an origin is expected and must succeed. There is no longer
 * a single-row-per-origin lookup; `findByOrigin` (global, no tenantId) is
 * GONE — it would be wrong by construction now that multiple rows can share
 * an origin. Callers that need every grant for an origin, or the full
 * registry rebuild, use `findAll({})` (inherited from `Repository`, sees
 * every tenant's rows because it runs outside a request CLS scope — see
 * `OriginRegistryService`).
 */
@Injectable()
export class TenantAllowedOriginRepository extends Repository<TenantAllowedOriginEntity, TenantAllowedOrigin> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantAllowedOrigin', TenantAllowedOriginEntityMapper.getInstance());
  }

  /**
   * Exact-match lookup by the (origin, tenantId) grant, ENABLED rows only.
   * This is the duplicate/restore check: does THIS tenant already hold a
   * (live or soft-deleted, per `resourceStatus`) grant on THIS origin. It
   * says nothing about whether some OTHER tenant also holds a grant on the
   * same origin — that is expected and is not this method's concern.
   */
  async findByOriginAndTenant(
    origin: string,
    tenantId: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<TenantAllowedOriginEntity | null> {
    const where = { origin, tenantId, resourceStatus: ResourceStatusType.ENABLED };

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
