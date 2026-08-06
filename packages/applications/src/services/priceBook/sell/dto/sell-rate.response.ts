import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiCapability, AiPriceBookPlane, AiPriceRowKind, AiUsageUnit, TenantPlan } from '@arcaai/domains';

/** One rate row. Money micros travel as decimal-integer STRINGS (bigint-safe). */
export class SellRateResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  tenantId!: string;

  @ApiProperty({ enum: AiPriceBookPlane })
  plane!: AiPriceBookPlane;

  @ApiProperty({ enum: AiPriceRowKind })
  rowKind!: AiPriceRowKind;

  @ApiPropertyOptional({ enum: TenantPlan, nullable: true })
  planTier!: TenantPlan | null;

  @ApiPropertyOptional({ enum: AiCapability, nullable: true })
  capability!: AiCapability | null;

  @ApiPropertyOptional({ nullable: true })
  provider!: string | null;

  @ApiPropertyOptional({ nullable: true })
  model!: string | null;

  @ApiPropertyOptional({ enum: AiUsageUnit, nullable: true })
  unit!: AiUsageUnit | null;

  @ApiPropertyOptional({ nullable: true })
  contextBand!: string | null;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ description: 'Integer micros per unit (or per period for PLAN_FEE), as a decimal-integer string.' })
  unitPriceMicros!: string;

  @ApiProperty({ description: 'ISO timestamp the row takes effect.' })
  effectiveFrom!: string;

  @ApiPropertyOptional({ description: 'ISO timestamp the row was superseded; null = still in force.', nullable: true })
  effectiveTo!: string | null;

  @ApiProperty()
  bookVersion!: string;

  @ApiProperty({ description: 'OCC version — drives the If-Match token for supersede.' })
  version!: number;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

/** Result of a supersede: the closed row and its successor, as one atomic pair. */
export class SellRateSupersedeResponse {
  @ApiProperty({ type: SellRateResponse })
  closed!: SellRateResponse;

  @ApiProperty({ type: SellRateResponse })
  successor!: SellRateResponse;
}
