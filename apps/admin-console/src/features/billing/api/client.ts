import { getJson, getWithEtag, postJson, request, versionFromEtag, type WithEtag } from '@/shared/api';

import type {
  AddAdjustmentRequest,
  BillingInvoice,
  BillingInvoiceSummary,
  ComputeDraftRequest,
  InvoiceListParams,
  SellRate,
  SellRateSupersede,
  SpendStatus,
  SupersedeSellRateRequest,
} from './types';

/**
 * Typed calls over the BFF proxy. Reads use `getJson`;
 * `getInvoice` captures the row ETag for the finalize/void OCC path. Finalize
 * and void send If-Match (`etag`) AND the derived `expectedVersion` in the body
 * — the house pattern (missing → 428, drift → 412). All routes are
 * GLOBAL_ADMIN-only, enforced server-side.
 */
const INVOICES = 'admin/billing/invoices';
const RATE_CARD = 'admin/billing/rate-card';

export function getInvoices(params?: InvoiceListParams): Promise<BillingInvoiceSummary[]> {
  return getJson(INVOICES, params);
}

export function getInvoice(id: string): Promise<WithEtag<BillingInvoice>> {
  return getWithEtag(`${INVOICES}/${id}`);
}

export function getSpendStatus(period?: string): Promise<SpendStatus> {
  return getJson(`${INVOICES}/spend-status`, period ? { period } : undefined);
}

export function getRateCard(): Promise<SellRate[]> {
  return getJson(RATE_CARD);
}

export function computeDraft(body: ComputeDraftRequest): Promise<BillingInvoice> {
  return postJson(`${INVOICES}/compute-draft`, body);
}

export async function finalizeInvoice(id: string, etag: string): Promise<BillingInvoice> {
  const result = await request<BillingInvoice>(`${INVOICES}/${id}/finalize`, {
    method: 'POST',
    body: { expectedVersion: versionFromEtag(etag) },
    etag,
  });
  return result.data;
}

export async function voidInvoice(id: string, etag: string): Promise<BillingInvoice> {
  const result = await request<BillingInvoice>(`${INVOICES}/${id}/void`, {
    method: 'POST',
    body: { expectedVersion: versionFromEtag(etag) },
    etag,
  });
  return result.data;
}

export function addAdjustment(id: string, body: AddAdjustmentRequest): Promise<BillingInvoice> {
  return postJson(`${INVOICES}/${id}/adjustments`, body);
}

/**
 * Supersede a rate row: close it at the successor's `effectiveFrom` and insert
 * the successor, atomically. If-Match carries the row version the
 * list read returned — missing → 428, drift → 412.
 *
 * A supersede REPRICES; it never re-shapes. Dimensions are inherited server-side,
 * so there is deliberately no way to edit capability/unit/provider here — that
 * would be a new row plus a supersede, two auditable intents rather than one
 * ambiguous edit.
 */
export async function supersedeSellRate(id: string, version: number, body: SupersedeSellRateRequest): Promise<SellRateSupersede> {
  const result = await request<SellRateSupersede>(`${RATE_CARD}/${id}/supersede`, {
    method: 'POST',
    body,
    etag: `"${version}"`,
  });
  return result.data;
}
