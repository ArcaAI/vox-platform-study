import Decimal from 'decimal.js';
import { BillingAdjustmentEntity, BillingInvoiceEntity, BillingInvoiceLineEntity, BillingInvoiceStatus, TenantPlan } from '@arcaai/domains';

import { periodOf } from './billing-period';
import type { PlanFeeBasis } from './invoice-math';
import { BillingAdjustmentResponse, BillingInvoiceLineResponse, BillingInvoiceResponse, BillingInvoiceSummaryResponse } from './dto';

/** Extras the read model derives outside the invoice row itself. */
export interface InvoiceResponseExtras {
  planTier: TenantPlan | null;
  byokNotionalCostMicros: bigint;
  rateCardVersions: string[];
  /**
   * How the plan fee was rated. Optional so a stored-invoice
   * re-read (which does not recompute the segments) defaults to the pre-#6
   * PERIOD_END_PLAN label; compute-draft passes the true basis.
   */
  planFeeBasis?: PlanFeeBasis;
}

/**
 * Entity → response mapping. Micros as decimal-integer strings, quantities as
 * decimal strings, timestamps ISO — money never rides a JSON double.
 */
export class BillingDtoMapper {
  static toLineResponse(entity: BillingInvoiceLineEntity): BillingInvoiceLineResponse {
    const response = new BillingInvoiceLineResponse();
    response.id = entity.id;
    response.kind = entity.kind;
    response.capability = entity.capability ?? null;
    response.unit = entity.unit ?? null;
    response.quantity = toDecimalString(entity.quantity);
    response.includedAllowance = toDecimalString(entity.includedAllowance);
    response.overageQuantity = toDecimalString(entity.overageQuantity);
    response.unitPriceMicros = entity.unitPriceMicros === null || entity.unitPriceMicros === undefined ? null : entity.unitPriceMicros.toString();
    response.amountMicros = entity.amountMicros.toString();
    response.description = entity.description ?? null;
    return response;
  }

  static toAdjustmentResponse(entity: BillingAdjustmentEntity): BillingAdjustmentResponse {
    const response = new BillingAdjustmentResponse();
    response.id = entity.id;
    response.reason = entity.reason;
    response.amountMicros = entity.amountMicros.toString();
    response.createdAt = entity.createdAt.toISOString();
    response.createdBy = entity.createdBy ?? null;
    return response;
  }

  static toInvoiceResponse(
    invoice: BillingInvoiceEntity,
    lines: BillingInvoiceLineEntity[],
    adjustments: BillingAdjustmentEntity[],
    extras: InvoiceResponseExtras,
  ): BillingInvoiceResponse {
    const response = new BillingInvoiceResponse();
    response.id = invoice.id;
    response.tenantId = invoice.tenantId;
    response.period = periodOf(invoice.periodStart).label;
    response.periodStart = invoice.periodStart.toISOString();
    response.periodEnd = invoice.periodEnd.toISOString();
    response.status = invoice.status ?? BillingInvoiceStatus.DRAFT;
    response.currency = invoice.currency ?? 'USD';
    response.subtotalMicros = (invoice.subtotalMicros ?? 0n).toString();
    response.totalMicros = (invoice.totalMicros ?? 0n).toString();
    response.finalizedAt = invoice.finalizedAt ? invoice.finalizedAt.toISOString() : null;
    response.finalizedBy = invoice.finalizedBy ?? null;
    response.version = invoice.version;
    response.planTier = extras.planTier;
    response.planFeeBasis = extras.planFeeBasis ?? 'PERIOD_END_PLAN';
    response.byokNotionalCostMicros = extras.byokNotionalCostMicros.toString();
    response.rateCardVersions = extras.rateCardVersions;
    response.lines = lines.map((line) => BillingDtoMapper.toLineResponse(line));
    response.adjustments = adjustments.map((adjustment) => BillingDtoMapper.toAdjustmentResponse(adjustment));

    const adjustmentsTotal = adjustments.reduce((acc, adjustment) => acc + adjustment.amountMicros, 0n);
    response.adjustmentsTotalMicros = adjustmentsTotal.toString();
    response.amountAfterAdjustmentsMicros = ((invoice.totalMicros ?? 0n) + adjustmentsTotal).toString();
    return response;
  }

  static toSummaryResponse(invoice: BillingInvoiceEntity): BillingInvoiceSummaryResponse {
    const response = new BillingInvoiceSummaryResponse();
    response.id = invoice.id;
    response.tenantId = invoice.tenantId;
    response.period = periodOf(invoice.periodStart).label;
    response.status = invoice.status ?? BillingInvoiceStatus.DRAFT;
    response.currency = invoice.currency ?? 'USD';
    response.totalMicros = (invoice.totalMicros ?? 0n).toString();
    response.finalizedAt = invoice.finalizedAt ? invoice.finalizedAt.toISOString() : null;
    response.version = invoice.version;
    return response;
  }
}

function toDecimalString(value: Decimal.Value | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Decimal(value).toString();
}
