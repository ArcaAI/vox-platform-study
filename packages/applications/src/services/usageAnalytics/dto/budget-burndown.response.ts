import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CapabilityBurndownLine {
  @ApiProperty()
  capability!: string;

  @ApiPropertyOptional({ nullable: true, description: 'null = unlimited (no allowance ceiling configured).' })
  allowance!: string | null;

  @ApiProperty({ description: 'Month-to-date usage in the capability billing unit.' })
  usedToDate!: string;

  @ApiPropertyOptional({ nullable: true, description: 'Linear end-of-month projection; null when unlimited.' })
  projectedTotal!: string | null;

  @ApiProperty({ description: 'True only when an allowance exists AND the linear projection exceeds it.' })
  projectedToExceed!: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'usedToDate / allowance × 100; null when unlimited.' })
  utilizationPercent!: number | null;
}

/** Allowances vs month-to-date usage vs days elapsed, with a linear exceed projection (TASK-615 WS-J). */
export class BudgetBurndownResponse {
  @ApiProperty({ description: 'Billing-period label, YYYY-MM.' })
  period!: string;

  @ApiProperty()
  periodStart!: string;

  @ApiProperty()
  periodEnd!: string;

  @ApiProperty({ description: 'Fraction of the period elapsed as of computedAt, (0, 1].' })
  fractionElapsed!: number;

  @ApiProperty()
  computedAt!: string;

  @ApiProperty({ type: CapabilityBurndownLine, isArray: true })
  capabilities!: CapabilityBurndownLine[];
}
