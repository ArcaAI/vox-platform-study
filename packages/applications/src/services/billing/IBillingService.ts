import { BillingInvoiceStatus, TenantPlan } from '@arcaai/domains';

import { AddAdjustmentRequest, BillingInvoiceResponse, BillingInvoiceSummaryResponse, SpendStatusResponse } from './dto';

/**
 * The invoice engine (decisions D11–D15).
 *
 * Lifecycle: DRAFT → FINALIZED (immutable) · DRAFT → VOID. Corrections to a
 * finalized period are `BillingAdjustment` credit memos, never mutations —
 * each memo nets as an ADJUSTMENT line on the draft of the period it was
 * issued in.
 *
 * `tenantId` on every method is the CALLER-SCOPED tenant (resolved by the
 * controller); a by-id read whose row belongs elsewhere returns 404, never 403.
 */
export interface IBillingService {
  /**
   * Compute — or idempotently recompute — the DRAFT for one tenant-month.
   * Reads rollups (never raw events), the PlanEntitlement←TenantEntitlement
   * allowance chain, and the SELL card; a recompute supersedes the draft's
   * lines in one transaction. FINALIZED/VOID periods refuse (409).
   */
  computeDraft(tenantId: string, period: string): Promise<BillingInvoiceResponse>;

  getInvoice(tenantId: string, invoiceId: string): Promise<BillingInvoiceResponse>;

  listInvoices(tenantId: string, status?: BillingInvoiceStatus): Promise<BillingInvoiceSummaryResponse[]>;

  /**
   * DRAFT → FINALIZED under OCC (`expectedVersion` from If-Match). Only after
   * the period has ended — a month is never closed while it is still running.
   */
  finalize(tenantId: string, invoiceId: string, expectedVersion: number): Promise<BillingInvoiceResponse>;

  /** DRAFT → VOID under OCC. One-way: a voided period stays void (v1 posture). */
  voidDraft(tenantId: string, invoiceId: string, expectedVersion: number): Promise<BillingInvoiceResponse>;

  /** Credit/debit memo against a FINALIZED invoice. Never touches lines or stored totals. */
  addAdjustment(tenantId: string, invoiceId: string, request: AddAdjustmentRequest): Promise<BillingInvoiceResponse>;

  /** Month-to-date SELL-rated overage spend vs the tenant spend limit (D12). Read-only. */
  getSpendStatus(tenantId: string, period: string): Promise<SpendStatusResponse>;

  /**
   * Enforcement precheck for the optional tenant spend limit (D12).
   * Throws `SpendLimitExceededException` (→ HTTP 402) when the tenant has SET a
   * monthly limit and its SELL-rated overage spend has reached it. Opt-in and
   * cheap by construction: a tenant with no limit set (the default — every
   * `monthlySpendLimitMicros` seeds NULL) returns immediately without computing
   * a draft, so the metered hot path pays nothing until a limit exists. `period`
   * defaults to the current UTC month.
   */
  assertSpendLimit(tenantId: string, period?: string): Promise<void>;

  /**
   * Append a plan-change fact to `TenantPlanHistory` — the source
   * the invoice engine prorates the plan fee from. Closes the tenant's open
   * window at `effectiveAt` and opens a new one for `newPlan` (or leaves it
   * closed when `newPlan` is null = plan removed). Idempotent: re-recording the
   * plan already in force is a no-op. This is the MECHANISM a plan-change action
   * calls (tenant onboarding for the initial window; a future change-plan flow
   * for subsequent ones); it does not itself change `Tenant.plan`.
   */
  recordPlanChange(tenantId: string, newPlan: TenantPlan | null, effectiveAt: Date, changeReason?: string): Promise<void>;
}

export const IBillingService = Symbol('IBillingService');
