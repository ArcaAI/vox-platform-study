import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { RateLimitRuleEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { RateLimitRuleEntityMapper } from '../../../mappers';
import { RateLimitRule } from '../../../models';

/**
 * Rate-limit rule repository (TASK-785).
 *
 * One rule per `(tenantId, routeMatch, matchKind)` — enforced by the
 * `RateLimitRule_scope_unique` index. A SYSTEM-tenant row is a platform-wide
 * per-route limit; a customer-tenant row overrides it for that tenant alone.
 *
 * `RateLimitRule` is tenant-scoped but deliberately NOT a SYSTEM-shared read
 * model: nothing resolves these rows under a tenant's CLS. The throttler reads
 * an in-memory cache, and {@link findAllForCache} — the only read that must see
 * EVERY tenant's rules at once — is called from inside `clsService.exit(...)`
 * so the tenant-scope extension passes through. See `RateLimitRuleCache`.
 */
@Injectable()
export class RateLimitRuleRepository extends Repository<RateLimitRuleEntity, RateLimitRule> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'rateLimitRule', RateLimitRuleEntityMapper.getInstance());
  }

  /**
   * EVERY live rule, across every tenant, for the throttler's in-memory cache.
   *
   * MUST be called outside tenant CLS (the caller wraps it in
   * `clsService.exit(...)`). Called under a tenant context the tenant-scope
   * extension would inject that tenant's id and the cache would be rebuilt
   * holding one tenant's view of the world — the cache-poisoning failure mode
   * TASK-771 fixed for `AppSettingsService`.
   */
  async findAllForCache(): Promise<RateLimitRuleEntity[]> {
    return this.findAll({ filters: { resourceStatus: ResourceStatusType.ENABLED } });
  }

  /**
   * The live rules owned EXACTLY by `tenantId` (no SYSTEM widening). Used by
   * the admin surface to list one scope, and by the service to enforce the
   * per-scope rule cap.
   */
  async findByTenant(tenantId: string, tx?: Prisma.TransactionClient | any): Promise<RateLimitRuleEntity[]> {
    const where = { tenantId, resourceStatus: ResourceStatusType.ENABLED };

    if (tx) {
      const models = await (tx as Record<string, any>).rateLimitRule.findMany({ where });
      return models.map((m: RateLimitRule) => RateLimitRuleEntityMapper.getInstance().toDomainEntity(m));
    }

    return this.findAll({ filters: where });
  }
}
