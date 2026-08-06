import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiCapability, AiUsageUnit, BillingInvoiceStatus, BillingLineKind, TenantPlan } from '@arcaai/domains';

/**
 * Invoice read model (TASK-615 D13).
 *
 * Money micros travel as decimal-integer STRINGS (bigint-safe in JSON);
 * quantities as decimal strings; timestamps as ISO strings. Nothing here is
 * PHI — capability/unit aggregates and bounded labels only (D17).
 */
export class BillingInvoiceLineResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: BillingLineKind })
  kind!: BillingLineKind;

  @ApiPropertyOptional({ enum: AiCapability, nullable: true })
  capability!: AiCapability | null;

  @ApiPropertyOptional({ enum: AiUsageUnit, nullable: true })
  unit!: AiUsageUnit | null;

  @ApiPropertyOptional({ description: 'PLAN_FEE: billed days · OVERAGE: whole-period billable usage of the unit.', nullable: true })
  quantity!: string | null;

  @ApiPropertyOptional({ description: 'The POOLED capability allowance the usage was measured against (D11).', nullable: true })
  includedAllowance!: string | null;

  @ApiPropertyOptional({ description: 'The overage portion this line bills.', nullable: true })
  overageQuantity!: string | null;

  @ApiPropertyOptional({ description: 'PLAN_FEE: full-period fee · OVERAGE: the SELL rate applied. Integer micros.', nullable: true })
  unitPriceMicros!: string | null;

  @ApiProperty({ description: 'Line amount, integer micros, HALF-UP at line level. Σ lines == invoice total.' })
  amountMicros!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;
}

export class BillingAdjustmentResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Bounded reason code.' })
  reason!: string;

  @ApiProperty({ description: 'Signed integer micros; negative = credit.' })
  amountMicros!: string;

  @ApiProperty()
  createdAt!: string;

  @ApiPropertyOptional({ nullable: true })
  createdBy!: string | null;
}

export class BillingInvoiceResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  tenantId!: string;

  @ApiProperty({ description: 'Billing period label, YYYY-MM (UTC calendar month).' })
  period!: string;

  @ApiProperty()
  periodStart!: string;

  @ApiProperty()
  periodEnd!: string;

  @ApiProperty({ enum: BillingInvoiceStatus })
  status!: BillingInvoiceStatus;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ description: 'Plan fee + overage before adjustments. Integer micros as a string.' })
  subtotalMicros!: string;

  @ApiProperty({ description: 'Subtotal + carried adjustment lines. Integer micros as a string.' })
  totalMicros!: string;

  @ApiPropertyOptional({ nullable: true })
  finalizedAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  finalizedBy!: string | null;

  @ApiProperty({ description: 'OCC version — drives the If-Match token for finalize/void.' })
  version!: number;

  @ApiPropertyOptional({ enum: TenantPlan, nullable: true, description: 'Plan the period was billed under; null = ungated-legacy tenant.' })
  planTier!: TenantPlan | null;

  @ApiProperty({
    description:
      'How the plan fee was derived. PERIOD_END_PLAN: no plan-change history exists, so the plan in force at computation ' +
      'time is billed for the whole period (allowances therefore apply retroactively on upgrade — D15). A future plan-history ' +
      'source upgrades this to true multi-segment daily proration without an engine change.',
  })
  planFeeBasis!: 'PERIOD_END_PLAN';

  @ApiProperty({
    description:
      "The tenant's notional BYOK provider spend for the period (D14) — a PRODUCT FEATURE, never an invoice line. " +
      'BYOK units still count toward allowances/overage; only this notional cost is excluded from billing.',
  })
  byokNotionalCostMicros!: string;

  @ApiProperty({
    type: [String],
    description: 'Distinct price-book versions consulted — a "placeholder" label here means the card is not commercially approved.',
  })
  rateCardVersions!: string[];

  @ApiProperty({ type: [BillingInvoiceLineResponse] })
  lines!: BillingInvoiceLineResponse[];

  @ApiProperty({
    type: [BillingAdjustmentResponse],
    description:
      'Credit/debit memos issued AGAINST this invoice after it finalized. Informational here — each memo NETS as an ' +
      'ADJUSTMENT line on the draft of the period it was issued in, never by mutating this invoice.',
  })
  adjustments!: BillingAdjustmentResponse[];

  @ApiProperty({ description: 'Σ memos against this invoice. Integer micros as a string.' })
  adjustmentsTotalMicros!: string;

  @ApiProperty({ description: 'totalMicros + adjustmentsTotalMicros — the corrected read-model figure for a finalized period.' })
  amountAfterAdjustmentsMicros!: string;
}

/** Compact list row (admin + tenant self-service lists). */
export class BillingInvoiceSummaryResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  tenantId!: string;

  @ApiProperty()
  period!: string;

  @ApiProperty({ enum: BillingInvoiceStatus })
  status!: BillingInvoiceStatus;

  @ApiProperty()
  currency!: string;

  @ApiProperty()
  totalMicros!: string;

  @ApiPropertyOptional({ nullable: true })
  finalizedAt!: string | null;

  @ApiProperty()
  version!: number;
}
