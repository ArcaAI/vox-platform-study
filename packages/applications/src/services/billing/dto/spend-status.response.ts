import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Month-to-date rated spend vs the tenant-set spend limit.
 *
 * "Rated spend" = the SELL-rated OVERAGE amount so far — spend BEYOND the
 * plan's included allowances, which is exactly what
 * `TenantEntitlement.monthlySpendLimitMicros` bounds (the plan fee is fixed and
 * predictable; the limit exists to cap the variable part). Exposed for later
 * enforcement wiring (402 when `exceeded`); this service never blocks anything
 * itself.
 */
export class SpendStatusResponse {
  @ApiProperty({ description: 'Billing period label, YYYY-MM.' })
  period!: string;

  @ApiProperty()
  periodStart!: string;

  @ApiProperty()
  periodEnd!: string;

  @ApiProperty({ description: 'Instant the status was computed (month-to-date cut).' })
  computedAt!: string;

  @ApiProperty({ description: 'SELL-rated overage spend so far this period. Integer micros as a string.' })
  overageSpendMicros!: string;

  @ApiPropertyOptional({ description: 'TenantEntitlement.monthlySpendLimitMicros; null = no self-imposed limit.', nullable: true })
  spendLimitMicros!: string | null;

  @ApiPropertyOptional({ description: 'max(0, limit − spent); null when no limit is set.', nullable: true })
  remainingMicros!: string | null;

  @ApiProperty({ description: 'True when spent >= limit — the 402 condition (D12).' })
  exceeded!: boolean;

  @ApiPropertyOptional({ description: 'floor(spent × 100 / limit); null when no limit is set.', nullable: true })
  utilizationPercent!: number | null;

  @ApiProperty({ description: 'Notional BYOK provider spend so far (D14 product feature).' })
  byokNotionalCostMicros!: string;
}
