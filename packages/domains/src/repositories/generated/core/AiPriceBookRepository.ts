import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AiPriceBookEntity } from '../../../entities';
import { AiCapability, AiPriceBookPlane, AiPriceRowKind, AiUsageUnit, ResourceStatusType, TenantPlan } from '../../../enums';
import { AiPriceBookEntityMapper } from '../../../mappers';
import { AiPriceBook } from '../../../models';

/** Dimensions of a COST-plane price lookup. */
export interface ResolveUsagePriceQuery {
  tenantId: string;
  plane: AiPriceBookPlane;
  capability: AiCapability;
  unit: AiUsageUnit;
  provider?: string | null;
  model?: string | null;
  contextBand?: string | null;
  /** The event's `occurredAt` — NEVER `recordedAt`. */
  at: Date;
}

/**
 * Effective-dated rate-card repository.
 *
 * `AiPriceBook` is a SYSTEM-shared read model: the tenant-scope extension widens
 * READS to `tenantId IN [caller, SYSTEM]` so a tenant's rater resolves the
 * platform card under its own CLS, while WRITES stay pinned to the caller
 * (rate-card mutation is GLOBAL_ADMIN-only at the service layer — the
 * `AiTaskDefault` / `HarnessPolicy` precedent).
 *
 * Unlike its siblings in the metering plane this model is ADMIN-MANAGED:
 * standard soft-delete lifecycle, sys-events on mutation.
 */
@Injectable()
export class AiPriceBookRepository extends Repository<AiPriceBookEntity, AiPriceBook> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'aiPriceBook', AiPriceBookEntityMapper.getInstance());
  }

  /**
   * Every candidate row whose effective window contains `at`, for one plane and
   * dimension set, most recently effective FIRST.
   *
   * Returns CANDIDATES rather than one row: which of them wins is a
   * most-specific-match policy that belongs in the application service (a row
   * with an exact `model` beats a provider-wide row beats a capability-wide
   * row), and encoding that here would bury a pricing decision in a repository.
   *
   * The window test is `effectiveFrom <= at AND (effectiveTo IS NULL OR
   * effectiveTo > at)` — half-open, so a supersede that closes one row at the
   * same instant the next opens yields exactly one match, never two and never
   * zero.
   *
   * DISABLED/DELETED rows are excluded (`ENABLED` only): retiring a mistaken
   * rate must actually take it out of the rater's reach.
   */
  async findEffectiveCandidates(query: ResolveUsagePriceQuery, tx?: Prisma.TransactionClient | any): Promise<AiPriceBookEntity[]> {
    const where: Record<string, unknown> = {
      tenantId: query.tenantId,
      plane: query.plane,
      rowKind: AiPriceRowKind.USAGE_UNIT,
      capability: query.capability,
      unit: query.unit,
      resourceStatus: ResourceStatusType.ENABLED,
      effectiveFrom: { lte: query.at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: query.at } }],
    };
    if (query.provider !== undefined) where.provider = query.provider;
    if (query.model !== undefined) where.model = query.model;
    if (query.contextBand !== undefined) where.contextBand = query.contextBand;

    const delegate = tx ? (tx as Record<string, any>).aiPriceBook : this.db;
    const models = await delegate.findMany({ where, orderBy: [{ effectiveFrom: 'desc' }] });
    const mapper = AiPriceBookEntityMapper.getInstance();
    return models.map((model: AiPriceBook) => mapper.toDomainEntity(model));
  }

  /**
   * The SELL-plane recurring fee for a plan tier, effective at `at`.
   *
   * `PLAN_FEE` rows are keyed by `planTier` alone, so unlike the usage lookup
   * above this one resolves to at most a single row.
   */
  async findEffectivePlanFee(tenantId: string, planTier: TenantPlan, at: Date, tx?: Prisma.TransactionClient | any): Promise<AiPriceBookEntity | null> {
    const delegate = tx ? (tx as Record<string, any>).aiPriceBook : this.db;
    const model = await delegate.findFirst({
      where: {
        tenantId,
        plane: AiPriceBookPlane.SELL,
        rowKind: AiPriceRowKind.PLAN_FEE,
        planTier,
        resourceStatus: ResourceStatusType.ENABLED,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }],
    });
    return model ? AiPriceBookEntityMapper.getInstance().toDomainEntity(model) : null;
  }

  /**
   * All rows of one book version — the audit read behind "which card priced this
   * invoice?".
   */
  async findByBookVersion(tenantId: string, bookVersion: string): Promise<AiPriceBookEntity[]> {
    const models = await this.db.findMany({
      where: { tenantId, bookVersion },
      orderBy: [{ effectiveFrom: 'asc' }],
    });
    const mapper = AiPriceBookEntityMapper.getInstance();
    return models.map((model: AiPriceBook) => mapper.toDomainEntity(model));
  }
}
