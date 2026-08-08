/**
 * Wire types for the Billing screen (TASK-615 #15b), backed by the gateway
 * `admin/billing/*` surface. Re-declared locally (rule 13). Money is ALWAYS an
 * integer-micros STRING; a versioned invoice carries a numeric `version` for the
 * If-Match/ETag optimistic-concurrency finalize/void path.
 */

export type BillingInvoiceStatus = 'DRAFT' | 'FINALIZED' | 'VOID';
export type BillingLineKind = 'PLAN_FEE' | 'OVERAGE' | 'ADJUSTMENT';
export type PlanFeeBasis = 'PERIOD_END_PLAN' | 'TENANT_PLAN_HISTORY';

export interface BillingInvoiceLine {
  id: string;
  kind: BillingLineKind;
  capability: string | null;
  unit: string | null;
  quantity: string | null;
  includedAllowance: string | null;
  overageQuantity: string | null;
  unitPriceMicros: string | null;
  amountMicros: string;
  description: string;
}

export interface BillingAdjustment {
  id: string;
  reason: string;
  /** Signed integer micros; negative = credit (the common case). */
  amountMicros: string;
  createdAt: string;
  createdBy: string | null;
}

export interface BillingInvoice {
  id: string;
  tenantId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  status: BillingInvoiceStatus;
  currency: string;
  subtotalMicros: string;
  totalMicros: string;
  finalizedAt: string | null;
  finalizedBy: string | null;
  version: number;
  planTier: string | null;
  planFeeBasis: PlanFeeBasis;
  byokNotionalCostMicros: string;
  rateCardVersions: string[];
  lines: BillingInvoiceLine[];
  adjustments: BillingAdjustment[];
  adjustmentsTotalMicros: string;
  amountAfterAdjustmentsMicros: string;
}

export interface BillingInvoiceSummary {
  id: string;
  tenantId: string;
  period: string;
  status: BillingInvoiceStatus;
  currency: string;
  totalMicros: string;
  finalizedAt: string | null;
  version: number;
}

export interface SpendStatus {
  period: string;
  periodStart: string;
  periodEnd: string;
  computedAt: string;
  overageSpendMicros: string;
  spendLimitMicros: string | null;
  remainingMicros: string | null;
  exceeded: boolean;
  utilizationPercent: number | null;
  byokNotionalCostMicros: string;
}

export interface SellRate {
  id: string;
  tenantId: string;
  plane: string;
  rowKind: string;
  planTier: string | null;
  capability: string | null;
  provider: string | null;
  model: string | null;
  unit: string | null;
  contextBand: string | null;
  currency: string;
  unitPriceMicros: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  bookVersion: string;
  version: number;
}

/**
 * Supersede one SELL rate row (TASK-638 §7). Dimensions are INHERITED — a
 * supersede reprices a row, it never re-shapes it, so only the price, the
 * effective instant and the book label are settable.
 */
export interface SupersedeSellRateRequest {
  /** Successor price, integer micros as a non-negative decimal string. */
  unitPriceMicros: string;
  /** ISO 8601 instant the successor takes effect = the instant the old row closes. */
  effectiveFrom: string;
  /** Book label of the successor row, e.g. "2026-09-01-commercial-v3". */
  bookVersion: string;
}

export interface SellRateSupersede {
  closed: SellRate;
  successor: SellRate;
}

export interface ComputeDraftRequest {
  tenantId: string;
  /** UTC month, YYYY-MM. */
  period: string;
}

export interface AddAdjustmentRequest {
  /** Bounded reason CODE, not prose (e.g. "goodwill_credit"). */
  reason: string;
  /** Signed integer micros as a decimal string; negative = credit. */
  amountMicros: string;
}

export interface InvoiceListParams {
  status?: BillingInvoiceStatus;
  [key: string]: string | number | boolean | undefined | null;
}
