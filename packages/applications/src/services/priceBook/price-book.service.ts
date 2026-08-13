import { Injectable, Logger } from '@nestjs/common';
import { AiPriceBookEntity, AiPriceBookRepository, AiPriceBookPlane, SYSTEM_TENANT_ID, TenantPlan } from '@arcaai/domains';

import { IPriceBookService, ResolvePlanePriceInput, ResolveUsagePriceInput, ResolvedPrice } from './IPriceBookService';
import { PriceCandidate, selectMostSpecificPrice } from './price-book.resolution';

/**
 * Effective-dated rate resolution (deliverable 3).
 *
 * ============================================================================
 * TENANT CARD BEATS PLATFORM CARD — the outermost precedence axis
 * ============================================================================
 * A tenant that has ANY matching row of its own for the requested
 * (plane, capability, unit) is priced off its own card, even when the platform
 * card carries a more specific row. That is what negotiating an enterprise rate
 * means: an override, not a suggestion. "Matching" still requires the row's own
 * dimensions to apply, so a tenant card covering only `openai` does not shadow
 * the platform's `anthropic` rate — it simply does not match, and resolution
 * falls through.
 *
 * Everything BELOW that axis (provider > model > contextBand > planTier, then
 * latest `effectiveFrom`, then newest id) lives in the pure
 * {@link selectMostSpecificPrice} so the rule can be reviewed on its own.
 *
 * NO CACHE, DELIBERATELY. A stale rate is a wrong invoice, and the only caller
 * on the hot path (the outbox drainer) already batches. When profiling says
 * otherwise, the cache key MUST include `tenantId` and the effective instant —
 * a name-keyed config cache serving one tenant's rate to another is the failure
 * mode `09-infrastructure-devops.md` §M4 exists to prevent.
 *
 * QUERY SHAPE: candidates are fetched WITHOUT a provider/model/contextBand
 * filter. Narrowing in SQL would drop the seeded `provider: null` catch-all
 * rows and would split the precedence rule across a where clause and a ranking
 * function — two places to get one decision wrong.
 */
@Injectable()
export class PriceBookService implements IPriceBookService {
  private readonly logger = new Logger(PriceBookService.name);

  constructor(private readonly priceBookRepository: AiPriceBookRepository) {}

  async resolveUsagePrice(input: ResolvePlanePriceInput): Promise<ResolvedPrice | null> {
    const dimensions = {
      tenantId: input.tenantId,
      provider: input.provider ?? null,
      model: input.model ?? null,
      contextBand: input.contextBand ?? null,
      planTier: input.planTier ?? null,
      cacheTtl: input.cacheTtl ?? null,
    };

    // 1. The tenant's own card, when it has one.
    if (input.tenantId !== SYSTEM_TENANT_ID) {
      const tenantWinner = selectMostSpecificPrice(await this.candidates(input, input.tenantId), dimensions);
      if (tenantWinner) return toResolvedPrice(tenantWinner);
    }

    // 2. The platform card.
    const systemWinner = selectMostSpecificPrice(await this.candidates(input, SYSTEM_TENANT_ID), dimensions);
    if (systemWinner) return toResolvedPrice(systemWinner);

    this.logger.warn({
      message: 'No effective price row resolved — the event will be recorded unrated',
      plane: input.plane,
      capability: input.capability,
      unit: input.unit,
      provider: input.provider ?? null,
      model: input.model ?? null,
      occurredAt: input.occurredAt.toISOString(),
    });
    return null;
  }

  resolveCostPrice(input: ResolveUsagePriceInput): Promise<ResolvedPrice | null> {
    return this.resolveUsagePrice({ ...input, plane: AiPriceBookPlane.COST });
  }

  resolveSellPrice(input: ResolveUsagePriceInput): Promise<ResolvedPrice | null> {
    return this.resolveUsagePrice({ ...input, plane: AiPriceBookPlane.SELL });
  }

  async resolvePlanFee(tenantId: string, planTier: TenantPlan, at: Date): Promise<ResolvedPrice | null> {
    if (tenantId !== SYSTEM_TENANT_ID) {
      const negotiated = await this.priceBookRepository.findEffectivePlanFee(tenantId, planTier, at);
      if (negotiated) return toResolvedPrice(toCandidate(negotiated));
    }

    const platform = await this.priceBookRepository.findEffectivePlanFee(SYSTEM_TENANT_ID, planTier, at);
    return platform ? toResolvedPrice(toCandidate(platform)) : null;
  }

  /**
   * Every ENABLED `USAGE_UNIT` row of one card whose effective window contains
   * `occurredAt`, for the requested (plane, capability, unit).
   *
   * `provider` / `model` / `contextBand` are LEFT OUT of the query on purpose —
   * see the class header.
   */
  private async candidates(input: ResolvePlanePriceInput, tenantId: string): Promise<PriceCandidate[]> {
    const rows = await this.priceBookRepository.findEffectiveCandidates({
      tenantId,
      plane: input.plane,
      capability: input.capability,
      unit: input.unit,
      at: input.occurredAt,
    });
    return rows.map(toCandidate);
  }
}

/** Narrow an entity to the fields resolution reads. */
function toCandidate(entity: AiPriceBookEntity): PriceCandidate {
  return {
    id: entity.id,
    tenantId: entity.tenantId,
    provider: entity.provider ?? null,
    model: entity.model ?? null,
    contextBand: entity.contextBand ?? null,
    planTier: entity.planTier ?? null,
    cacheTtl: entity.cacheTtl ?? null,
    unitPriceMicros: entity.unitPriceMicros,
    bookVersion: entity.bookVersion,
    currency: entity.currency ?? 'USD',
    effectiveFrom: entity.effectiveFrom,
  };
}

function toResolvedPrice(candidate: PriceCandidate): ResolvedPrice {
  return {
    priceBookId: candidate.id,
    unitPriceMicros: candidate.unitPriceMicros,
    bookVersion: candidate.bookVersion,
    currency: candidate.currency,
  };
}
