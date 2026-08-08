import Decimal from 'decimal.js';
import { AiCapability, AiUsageUnit, BillingLineKind, TenantPlan } from '@arcaai/domains';

import { computeCostMicros } from '../priceBook/price-book.resolution';
import { BillingPeriod, truncateToUtcDay, utcDayCount } from './billing-period';

/**
 * The invoice engine's money math (TASK-615 WS-I, decisions D11–D15).
 *
 * PURE. No repository, no clock, no DI. Every rule that decides what a tenant
 * pays lives in this file so it can be reviewed, golden-tested and reproduced
 * on its own; `BillingService` only fetches inputs and persists outputs.
 *
 * ============================================================================
 * THE ONE ROUNDING RULE
 * ============================================================================
 * Integer micros end to end; Decimal for every intermediate product; HALF-UP
 * applied ONCE per line (the same `computeCostMicros` the at-ingest COST rater
 * uses, so the two planes can never round differently). Totals are plain
 * bigint sums of line amounts — Σ lines == total BY CONSTRUCTION, which the
 * property test then re-proves against independent recomputation.
 *
 * ============================================================================
 * OVERAGE ATTRIBUTION (D11 pooled allowance × D12 per-unit rates × supersede-
 * only rate card)
 * ============================================================================
 * A capability's allowance is POOLED (e.g. `monthlyLlmTokens` covers all five
 * token kinds) but SELL rates are per unit and effective-dated. Reconciling the
 * three requires an attribution rule, fixed as:
 *
 *  1. CHRONOLOGICAL CROSSING, day grain. Walk the period's UTC day buckets in
 *     order; the day the cumulative usage crosses the allowance is where
 *     overage starts: `dayOverage = max(0, cumAfter − max(allowance, cumBefore))`.
 *     Day grain because rollups are the invoice-time source (never raw events,
 *     D13) and the rollup day bucket is the finest time the invoice can see.
 *  2. PRO-RATA UNIT SPLIT inside the crossing day. A day's overage is split
 *     across that day's units in proportion to their quantities — deterministic
 *     and order-independent, unlike "whichever unit happened to arrive last".
 *     Shares are floored to 6 dp (the ledger's quantity scale) with the
 *     remainder assigned to the LAST unit in canonical enum order, so the split
 *     preserves the day's overage EXACTLY.
 *  3. RATE AT THE DAY BUCKET. Each (unit, day) portion is priced at the SELL
 *     row effective at that day's UTC midnight — a mid-month reprice therefore
 *     yields one line per rate row ("split-rate month"), each carrying its own
 *     full derivation (quantity → allowance → overage → rate → amount).
 *
 * FAIL-CLOSED: the COST rater records an event unrated when no price resolves
 * (a missing rate is repairable later); an INVOICE LINE is money and cannot be
 * "unrated" — a missing SELL rate throws {@link MissingSellRateError} and the
 * draft computation fails loudly instead of silently billing zero.
 */

/** A resolved SELL rate for one (unit, day) — see `IPriceBookService`. */
export interface ResolvedSellRate {
  priceBookId: string;
  unitPriceMicros: bigint;
  bookVersion: string;
  currency: string;
}

/** Rate lookup the engine calls per (unit, UTC day). `null` = no rate on the card. */
export type SellRateResolver = (unit: AiUsageUnit, day: Date) => ResolvedSellRate | null;

/** One day-bucket of billable usage for one unit (already operation-filtered). */
export interface DailyUnitQuantity {
  day: Date;
  unit: AiUsageUnit;
  quantity: Decimal;
}

/** A line before persistence — the full dispute-answerable derivation. */
export interface InvoiceLineDraft {
  kind: BillingLineKind;
  capability: AiCapability | null;
  unit: AiUsageUnit | null;
  /** PLAN_FEE: billed day count · OVERAGE: the unit's whole-period billable usage. */
  quantity: Decimal | null;
  /** OVERAGE: the POOLED capability allowance the usage was measured against. */
  includedAllowance: Decimal | null;
  /** OVERAGE: the portion of the overage this line bills, in `unit`. */
  overageQuantity: Decimal | null;
  /** PLAN_FEE: the full-period fee · OVERAGE: the SELL rate applied. */
  unitPriceMicros: bigint | null;
  /** HALF-UP at line level. The ONLY field that reaches the totals. */
  amountMicros: bigint;
  /** Bounded human label — enum-ish vocabulary only, never tenant input. */
  description: string;
}

/** One plan-fee segment of the period (multi-segment once a plan history source exists). */
export interface PlanFeeSegment {
  planTier: TenantPlan;
  /** Clamped to the period by the caller. */
  from: Date;
  to: Date;
  /** The SELL `PLAN_FEE` row's per-period fee. */
  feeMicrosPerPeriod: bigint;
  priceBookId: string;
  bookVersion: string;
  currency: string;
}

/**
 * How the plan fee was derived (TASK-615 #6, surfaced on the response):
 *   - `PERIOD_END_PLAN`   — no plan-change history for the period; the plan in
 *                           force at computation time is billed for the whole period.
 *   - `TENANT_PLAN_HISTORY` — `TenantPlanHistory` supplied dated segments, so the
 *                           fee is prorated per segment (true mid-period proration).
 */
export type PlanFeeBasis = 'PERIOD_END_PLAN' | 'TENANT_PLAN_HISTORY';

/** A dated plan interval before clamping — one `TenantPlanHistory` row. */
export interface PlanInterval {
  plan: TenantPlan;
  from: Date;
  /** null = still in force. */
  to: Date | null;
}

/** A plan interval clamped to the billing period (half-open). */
export interface ClampedPlanInterval {
  plan: TenantPlan;
  from: Date;
  to: Date;
}

/**
 * Clamp dated plan intervals to [period.start, period.end) and drop any that
 * collapse to zero days (TASK-615 #6). An open interval (`to: null`) runs to
 * period end. Each surviving interval becomes one `PlanFeeSegment`, so a
 * mid-period plan change bills `fee × ownedDays / periodDays` per segment via
 * the already-multi-segment {@link computePlanFeeLines}.
 */
export function clampPlanSegments(intervals: readonly PlanInterval[], period: BillingPeriod): ClampedPlanInterval[] {
  const out: ClampedPlanInterval[] = [];
  for (const interval of intervals) {
    const from = interval.from.getTime() < period.start.getTime() ? period.start : interval.from;
    const rawTo = interval.to ?? period.end;
    const to = rawTo.getTime() > period.end.getTime() ? period.end : rawTo;
    if (utcDayCount(from, to) <= 0) continue;
    out.push({ plan: interval.plan, from, to });
  }
  return out;
}

export interface CapabilityOverageInput {
  capability: AiCapability;
  /** Pooled allowance in the capability's billing units; `null` = unlimited (D11). */
  allowance: Decimal | null;
  /** Billable usage only — operation filtering happened upstream (D16). */
  usage: DailyUnitQuantity[];
}

export interface CapabilityOverageResult {
  lines: InvoiceLineDraft[];
  /** Whole-period billable usage across all units of the capability. */
  totalQuantity: Decimal;
  /** max(0, totalQuantity − allowance) — exactly the sum of the lines' overage quantities. */
  overageQuantity: Decimal;
  /** Distinct book versions consulted (audit surfacing, e.g. placeholder cards). */
  bookVersions: string[];
}

/** A SELL rate needed by the engine is absent from the card — the draft must not compute. */
export class MissingSellRateError extends Error {
  constructor(
    public readonly capability: AiCapability,
    public readonly unit: AiUsageUnit,
    public readonly day: Date,
  ) {
    super(
      `No effective SELL rate for ${capability}/${unit} at ${day.toISOString()} — the rate card is incomplete; superseding it forward is the fix.`,
    );
    this.name = 'MissingSellRateError';
  }
}

/** Two rate rows of one computation disagree on currency — v1 invoices are single-currency. */
export class CurrencyMismatchError extends Error {
  constructor(seen: string[]) {
    super(`Invoice computation crossed currencies [${seen.join(', ')}] — a v1 invoice is single-currency.`);
    this.name = 'CurrencyMismatchError';
  }
}

/** Canonical unit order — fixes pro-rata remainder assignment deterministically. */
const UNIT_ORDER: Record<AiUsageUnit, number> = Object.fromEntries(Object.values(AiUsageUnit).map((unit, index) => [unit, index])) as Record<
  AiUsageUnit,
  number
>;

const QUANTITY_DECIMALS = 6; // the ledger's Decimal(24,6) scale

// ---------------------------------------------------------------------------
// Plan fee (D15 — daily proration by day-bucket ownership)
// ---------------------------------------------------------------------------

/**
 * One PLAN_FEE line per segment: `fee × ownedDays / periodDays`, HALF-UP at the
 * line. A single segment covering the whole period bills EXACTLY the fee (the
 * ordinary case must never lose a micro to proration). Zero-day segments are
 * dropped; a zero-PRICED fee (TRIAL) still emits its line — free by decision is
 * a statement the invoice should carry.
 */
export function computePlanFeeLines(segments: readonly PlanFeeSegment[], period: BillingPeriod): InvoiceLineDraft[] {
  const periodDays = utcDayCount(period.start, period.end);
  const lines: InvoiceLineDraft[] = [];

  for (const segment of segments) {
    const days = utcDayCount(segment.from, segment.to);
    if (days === 0) continue;

    const amountMicros =
      days === periodDays
        ? segment.feeMicrosPerPeriod // exact — bypass the division entirely
        : BigInt(
            new Decimal(segment.feeMicrosPerPeriod.toString()).times(days).dividedBy(periodDays).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0),
          );

    lines.push({
      kind: BillingLineKind.PLAN_FEE,
      capability: null,
      unit: null,
      quantity: new Decimal(days),
      includedAllowance: null,
      overageQuantity: null,
      unitPriceMicros: segment.feeMicrosPerPeriod,
      amountMicros,
      description: `${segment.planTier} plan fee — ${days}/${periodDays} days`,
    });
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Overage (D11/D12 — see the file header for the attribution rule)
// ---------------------------------------------------------------------------

export function computeCapabilityOverage(input: CapabilityOverageInput, resolveRate: SellRateResolver): CapabilityOverageResult {
  // ---- normalize: (day, unit) → quantity, dropping zero/negative noise ------
  const byDay = new Map<number, Map<AiUsageUnit, Decimal>>();
  const perUnitTotals = new Map<AiUsageUnit, Decimal>();
  let totalQuantity = new Decimal(0);

  for (const bucket of input.usage) {
    if (bucket.quantity.lessThanOrEqualTo(0)) continue;
    const dayKey = truncateToUtcDay(bucket.day).getTime();
    const units = byDay.get(dayKey) ?? new Map<AiUsageUnit, Decimal>();
    units.set(bucket.unit, (units.get(bucket.unit) ?? new Decimal(0)).plus(bucket.quantity));
    byDay.set(dayKey, units);
    perUnitTotals.set(bucket.unit, (perUnitTotals.get(bucket.unit) ?? new Decimal(0)).plus(bucket.quantity));
    totalQuantity = totalQuantity.plus(bucket.quantity);
  }

  const noOverage: CapabilityOverageResult = { lines: [], totalQuantity, overageQuantity: new Decimal(0), bookVersions: [] };
  if (input.allowance === null || totalQuantity.lessThanOrEqualTo(input.allowance)) {
    return noOverage; // unlimited, or allowance covers everything — incl. "exactly consumed"
  }

  // ---- chronological crossing + pro-rata unit split -------------------------
  interface RateGroup {
    unit: AiUsageUnit;
    rate: ResolvedSellRate;
    overage: Decimal;
    firstDay: number;
  }
  const groups = new Map<string, RateGroup>(); // key: unit :: priceBookId
  const currencies = new Set<string>();
  const bookVersions = new Set<string>();

  const allowance = input.allowance;
  let cumulative = new Decimal(0);

  for (const dayKey of [...byDay.keys()].sort((a, b) => a - b)) {
    const units = byDay.get(dayKey)!;
    const dayTotal = [...units.values()].reduce((acc, q) => acc.plus(q), new Decimal(0));
    const cumulativeAfter = cumulative.plus(dayTotal);
    const dayOverage = Decimal.max(0, cumulativeAfter.minus(Decimal.max(allowance, cumulative)));
    cumulative = cumulativeAfter;
    if (dayOverage.isZero()) continue;

    // Pro-rata split, canonical unit order; floor-to-6dp shares with the exact
    // remainder assigned to the last unit so Σ shares == dayOverage EXACTLY.
    const orderedUnits = [...units.keys()].sort((a, b) => UNIT_ORDER[a] - UNIT_ORDER[b]);
    let assigned = new Decimal(0);
    orderedUnits.forEach((unit, index) => {
      const isLast = index === orderedUnits.length - 1;
      const share = isLast
        ? dayOverage.minus(assigned)
        : dayOverage.times(units.get(unit)!).dividedBy(dayTotal).toDecimalPlaces(QUANTITY_DECIMALS, Decimal.ROUND_FLOOR);
      assigned = assigned.plus(share);
      if (share.lessThanOrEqualTo(0)) return;

      const day = new Date(dayKey);
      const rate = resolveRate(unit, day);
      if (!rate) throw new MissingSellRateError(input.capability, unit, day);
      currencies.add(rate.currency);
      bookVersions.add(rate.bookVersion);

      const groupKey = `${unit}::${rate.priceBookId}`;
      const group = groups.get(groupKey);
      if (group) {
        group.overage = group.overage.plus(share);
        group.firstDay = Math.min(group.firstDay, dayKey);
      } else {
        groups.set(groupKey, { unit, rate, overage: share, firstDay: dayKey });
      }
    });
  }

  if (currencies.size > 1) throw new CurrencyMismatchError([...currencies].sort());

  // ---- one line per (unit, rate row), deterministic order --------------------
  const lines = [...groups.values()]
    .sort((a, b) => UNIT_ORDER[a.unit] - UNIT_ORDER[b.unit] || a.firstDay - b.firstDay || (a.rate.priceBookId < b.rate.priceBookId ? -1 : 1))
    .map((group): InvoiceLineDraft => ({
      kind: BillingLineKind.OVERAGE,
      capability: input.capability,
      unit: group.unit,
      quantity: perUnitTotals.get(group.unit) ?? new Decimal(0),
      includedAllowance: allowance,
      overageQuantity: group.overage,
      unitPriceMicros: group.rate.unitPriceMicros,
      // The ONE rounding rule: HALF-UP, once, at the line — via the SAME
      // helper the COST rater uses, so the planes can never round apart.
      amountMicros: computeCostMicros(group.overage, group.rate.unitPriceMicros),
      description: `${input.capability} ${group.unit} overage — from ${new Date(group.firstDay).toISOString().slice(0, 10)}`,
    }));

  return {
    lines,
    totalQuantity,
    overageQuantity: totalQuantity.minus(allowance),
    bookVersions: [...bookVersions].sort(),
  };
}

// ---------------------------------------------------------------------------
// Totals (D13)
// ---------------------------------------------------------------------------

export interface InvoiceTotals {
  /** Plan fee + overage, BEFORE adjustments. */
  subtotalMicros: bigint;
  /** Subtotal + Σ adjustment lines (credits negative). */
  totalMicros: bigint;
}

/** Plain bigint sums of line amounts — Σ lines == total by construction. */
export function computeInvoiceTotals(lines: readonly InvoiceLineDraft[]): InvoiceTotals {
  let subtotalMicros = 0n;
  let adjustmentMicros = 0n;
  for (const line of lines) {
    if (line.kind === BillingLineKind.ADJUSTMENT) {
      adjustmentMicros += line.amountMicros;
    } else {
      subtotalMicros += line.amountMicros;
    }
  }
  return { subtotalMicros, totalMicros: subtotalMicros + adjustmentMicros };
}
