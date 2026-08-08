import Decimal from 'decimal.js';
import { TenantPlan } from '@arcaai/domains';

/**
 * Price resolution precedence + money arithmetic (TASK-615 WS-B).
 *
 * PURE. No repository, no clock, no DI — the rule that decides what a tenant
 * pays has to be reviewable and reproducible on its own, and an `ORDER BY`
 * buried in a query is neither.
 *
 * ============================================================================
 * PRECEDENCE — MOST SPECIFIC WINS
 * ============================================================================
 * A candidate is any ENABLED row of the requested (plane, capability, unit)
 * whose effective window contains the event's `occurredAt`. Among those:
 *
 *  0. **A non-null dimension that disagrees with the query EXCLUDES the row.**
 *     A NULL dimension is a wildcard, not a mismatch — that is what makes the
 *     seeded `provider: null` self-hosted catch-alls work whatever engine id
 *     the emitter lanes settle on.
 *
 *  1. **Specificity, in this order:** provider (8) > model (4) > contextBand (2)
 *     > planTier (1). Weighted so `(provider + model)` beats `(provider)` beats
 *     the capability catch-all, and so a provider-specific row is never
 *     out-ranked by a merely tier-specific one.
 *
 *  2. **Tie-break: latest `effectiveFrom`** — the supersede that was opened
 *     most recently.
 *
 *  3. **Final tie-break: highest `id`.** Ids are UUIDv7, so lexicographic order
 *     is insertion order. Two rows sharing an `effectiveFrom` is an operator
 *     mistake, but resolution must still be REPRODUCIBLE: an invoice recomputed
 *     next month has to select the row it selected this month.
 *
 * TENANT-OWNED vs SYSTEM is resolved OUTSIDE this function, in the service: a
 * tenant that has any matching row of its own is priced entirely off its own
 * card (that is what negotiating an enterprise rate means). See
 * `price-book.service.ts`.
 */

/** The subset of an `AiPriceBook` row that resolution actually reads. */
export interface PriceCandidate {
  id: string;
  tenantId: string;
  provider: string | null;
  model: string | null;
  contextBand: string | null;
  planTier: TenantPlan | null;
  /** Cache-write TTL band ("5m"/"1h"); null = TTL-agnostic wildcard (TASK-615 #7). */
  cacheTtl: string | null;
  unitPriceMicros: bigint;
  bookVersion: string;
  currency: string;
  effectiveFrom: Date;
}

/** The dimensions of the event being priced. */
export interface PriceQueryDimensions {
  tenantId: string;
  provider: string | null;
  model: string | null;
  contextBand: string | null;
  planTier: TenantPlan | null;
  /**
   * From `attributesJson.cacheTtl` on a CACHE_WRITE_TOKEN event (TASK-615 #7).
   * Optional because it applies to a single unit — omitting it (like a null)
   * resolves the TTL-agnostic wildcard row, the pre-#7 behavior for every other
   * unit.
   */
  cacheTtl?: string | null;
}

// Powers of two so each dimension's presence dominates the sum of all
// less-significant ones (a provider match can never be out-ranked by
// model+contextBand+planTier+cacheTtl combined). `cacheTtl` is the LEAST
// significant new dimension (TASK-615 #7): it leaves the existing
// provider > model > contextBand > planTier precedence untouched and only lets
// a TTL-specific cache-write row beat the TTL-agnostic wildcard.
const WEIGHT_PROVIDER = 16;
const WEIGHT_MODEL = 8;
const WEIGHT_CONTEXT_BAND = 4;
const WEIGHT_PLAN_TIER = 2;
const WEIGHT_CACHE_TTL = 1;

/**
 * Pick the row that prices this event, or `null` when none applies.
 *
 * Independent of candidate ordering: the caller may hand rows over in any order
 * and get the same answer.
 */
export function selectMostSpecificPrice(candidates: readonly PriceCandidate[], query: PriceQueryDimensions): PriceCandidate | null {
  let best: PriceCandidate | null = null;
  let bestScore = -1;

  for (const row of candidates) {
    if (!matches(row.provider, query.provider)) continue;
    if (!matches(row.model, query.model)) continue;
    if (!matches(row.contextBand, query.contextBand)) continue;
    if (!matches(row.planTier, query.planTier)) continue;
    if (!matches(row.cacheTtl, query.cacheTtl)) continue;

    const score = specificity(row);
    if (best === null || score > bestScore || (score === bestScore && outranksOnTieBreak(row, best))) {
      best = row;
      bestScore = score;
    }
  }

  return best;
}

/**
 * `quantity x unitPriceMicros`, rounded HALF-UP to whole micros.
 *
 * `Decimal` throughout, `bigint` out. Quantities are fractional (audio seconds,
 * GPU seconds) and prices are integer micros; doing this in JS floats produces
 * `37.037034000000004` for a figure that must be exactly 37, and the errors
 * compound across a month of events. HALF-UP at the micro is the ONE documented
 * rounding rule for this platform — WS-I applies the same rule at the invoice
 * line, so a total never disagrees with the sum of its parts.
 *
 * A price of 0 is a legitimate answer (see the seeded zero-cost rows), so this
 * returns `0n` rather than treating it as "unpriced".
 */
export function computeCostMicros(quantity: Decimal.Value, unitPriceMicros: bigint): bigint {
  const cost = new Decimal(quantity).times(new Decimal(unitPriceMicros.toString())).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return BigInt(cost.toFixed(0));
}

/** A NULL row dimension is a wildcard; a set one must equal the query's value. */
function matches(rowValue: string | TenantPlan | null, queryValue: string | TenantPlan | null | undefined): boolean {
  if (rowValue === null || rowValue === undefined) return true;
  return rowValue === queryValue;
}

function specificity(row: PriceCandidate): number {
  return (
    (row.provider !== null ? WEIGHT_PROVIDER : 0) +
    (row.model !== null ? WEIGHT_MODEL : 0) +
    (row.contextBand !== null ? WEIGHT_CONTEXT_BAND : 0) +
    (row.planTier !== null ? WEIGHT_PLAN_TIER : 0) +
    (row.cacheTtl !== null ? WEIGHT_CACHE_TTL : 0)
  );
}

/** Latest `effectiveFrom` first; on a dead heat, the highest (newest) UUIDv7 id. */
function outranksOnTieBreak(row: PriceCandidate, incumbent: PriceCandidate): boolean {
  const delta = row.effectiveFrom.getTime() - incumbent.effectiveFrom.getTime();
  if (delta !== 0) return delta > 0;
  return row.id > incumbent.id;
}
