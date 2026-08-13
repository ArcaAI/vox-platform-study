import { AiCapability, AiPriceBookPlane, AiUsageUnit, TenantPlan } from '@arcaai/domains';

/**
 * A resolved rate, ready to stamp onto a ledger row or an invoice line.
 *
 * `bookVersion` is the load-bearing field: it records WHICH card produced the
 * number, so an invoice stays reproducible after the rate card moves on and a
 * disputed line can be traced back to the row that priced it.
 */
export interface ResolvedPrice {
  /** `AiPriceBook.id` of the winning row. */
  priceBookId: string;
  /** Integer micros (1e-6 of `currency`) per ONE unit, or per period for a plan fee. */
  unitPriceMicros: bigint;
  /** Label of the book the row belongs to (e.g. `2026-08-06-placeholder-v1`). */
  bookVersion: string;
  currency: string;
}

/** Dimensions of a usage-unit price lookup. */
export interface ResolveUsagePriceInput {
  /** The tenant whose card is consulted first; SYSTEM is the platform fallback. */
  tenantId: string;
  capability: AiCapability;
  unit: AiUsageUnit;
  /**
   * When the usage HAPPENED. Never `recordedAt` — a backfilled or abort-path
   * event observed weeks late must still be priced at the rate that was in
   * force when the work was done.
   */
  occurredAt: Date;
  provider?: string | null;
  model?: string | null;
  /** Long-context price band, when the provider prices one. */
  contextBand?: string | null;
  /** Plan tier — SELL-plane only; COST rows are tier-agnostic. */
  planTier?: TenantPlan | null;
  /**
   * Cache-write TTL band ("5m"/"1h") for a CACHE_WRITE_TOKEN event.
   * A TTL-keyed row wins over the TTL-agnostic wildcard; null resolves the
   * blended wildcard rate exactly as before this dimension existed.
   */
  cacheTtl?: string | null;
}

/** Same shape with the plane made explicit (used by the generic entry point). */
export interface ResolvePlanePriceInput extends ResolveUsagePriceInput {
  plane: AiPriceBookPlane;
}

/**
 * Effective-dated rate resolution over `AiPriceBook` (/ D10).
 *
 * TWO PLANES, ONE MECHANISM:
 *   - **COST** — what a call costs the PLATFORM. Read by the at-ingest rater in
 *     the outbox drainer; stamped onto every `AiUsageEvent`.
 *   - **SELL** — the tenant-facing card. Read only by 's invoice engine.
 *
 * They are never conflated: COST moves when a vendor reprices, SELL moves when
 * the product decides to.
 *
 * RATING FAILS OPEN. An unresolvable price returns `null` and the caller records
 * the event unrated rather than dropping it — a missing rate is repairable by
 * back-rating from the raw ledger, a missing event is not.
 */
export interface IPriceBookService {
  /** Resolve on an explicit plane. */
  resolveUsagePrice(input: ResolvePlanePriceInput): Promise<ResolvedPrice | null>;

  /** COST plane — the at-ingest rater's entry point. */
  resolveCostPrice(input: ResolveUsagePriceInput): Promise<ResolvedPrice | null>;

  /** SELL plane — the invoice engine's entry point. */
  resolveSellPrice(input: ResolveUsagePriceInput): Promise<ResolvedPrice | null>;

  /**
   * The recurring SELL-plane fee for a plan tier, effective at `at`.
   * Tenant card first, SYSTEM card second, `null` when neither carries the tier.
   */
  resolvePlanFee(tenantId: string, planTier: TenantPlan, at: Date): Promise<ResolvedPrice | null>;
}

export const IPriceBookService = Symbol('IPriceBookService');
