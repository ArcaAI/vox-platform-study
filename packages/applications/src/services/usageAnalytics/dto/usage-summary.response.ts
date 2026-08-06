import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One (capability × provider × model × unit) rollup slice, summed over the
 * requested period (TASK-615 WS-J).
 *
 * Money as integer-micros STRINGS (WS-I convention — a JSON number is an IEEE
 * double and these values are already rated in the ledger).
 */
export class UsageSummaryLine {
  @ApiProperty()
  capability!: string;

  @ApiProperty()
  provider!: string;

  @ApiPropertyOptional({ description: 'Empty string sentinel when the capability selects no model.' })
  model!: string;

  @ApiProperty()
  unit!: string;

  @ApiProperty({ description: 'Summed quantity in the unit above.' })
  quantity!: string;

  @ApiProperty({ description: 'Summed INTERNAL-basis rated cost, integer micros. Excludes BYOK_NOTIONAL (see byokNotionalCostMicros).' })
  costMicros!: string;
}

export class UsageSummaryResponse {
  @ApiProperty({ description: 'Billing-period label, YYYY-MM.' })
  period!: string;

  @ApiProperty()
  periodStart!: string;

  @ApiProperty()
  periodEnd!: string;

  @ApiProperty({ type: UsageSummaryLine, isArray: true })
  lines!: UsageSummaryLine[];

  @ApiProperty({ description: 'Σ costMicros across every line (INTERNAL basis only).' })
  totalCostMicros!: string;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' }, description: 'BYOK notional spend by capability, integer micros. A product-visibility figure — never billed (D14).' })
  byokNotionalCostMicrosByCapability!: Record<string, string>;
}
