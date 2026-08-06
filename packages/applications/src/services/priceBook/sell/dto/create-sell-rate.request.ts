import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { AiCapability, AiPriceRowKind, AiUsageUnit, TenantPlan } from '@arcaai/domains';

/**
 * Create one SELL-plane rate row (TASK-615 D10/D12).
 *
 * The plane is NOT a field — this surface manages the SELL card only and the
 * service pins it. `unitPriceMicros` is a decimal-integer STRING because money
 * micros are bigint end to end and a JSON number is an IEEE double.
 */
export class CreateSellRateRequest {
  @ApiPropertyOptional({ description: 'Owning tenant. Omit for the SYSTEM platform card; set for a negotiated enterprise card.' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiProperty({ enum: AiPriceRowKind, description: 'USAGE_UNIT = an overage rate · PLAN_FEE = a recurring per-period plan fee.' })
  @IsEnum(AiPriceRowKind)
  rowKind!: AiPriceRowKind;

  @ApiPropertyOptional({ enum: TenantPlan, description: 'Required for PLAN_FEE rows; optional tier dimension on USAGE_UNIT rows (per-tier overage premium, D12).' })
  @IsOptional()
  @IsEnum(TenantPlan)
  planTier?: TenantPlan;

  @ApiPropertyOptional({ enum: AiCapability, description: 'Required for USAGE_UNIT rows; forbidden on PLAN_FEE rows.' })
  @IsOptional()
  @IsEnum(AiCapability)
  capability?: AiCapability;

  @ApiPropertyOptional({ description: 'Optional provider dimension (lowercase connection/engine id — the WS-B provider shape).' })
  @IsOptional()
  @Matches(/^[a-z0-9][a-z0-9._-]{0,63}$/)
  provider?: string;

  @ApiPropertyOptional({ description: 'Optional model dimension.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;

  @ApiPropertyOptional({ enum: AiUsageUnit, description: 'Required for USAGE_UNIT rows; forbidden on PLAN_FEE rows.' })
  @IsOptional()
  @IsEnum(AiUsageUnit)
  unit?: AiUsageUnit;

  @ApiPropertyOptional({ description: 'Optional long-context price band (e.g. "0-128k").' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  contextBand?: string;

  @ApiPropertyOptional({ description: 'ISO 4217 currency. Defaults to USD; v1 invoices are single-currency.' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiProperty({ description: 'Integer micros (1e-6 of currency) per unit — or per period for PLAN_FEE. Non-negative decimal-integer string.', example: '6' })
  @Matches(/^\d{1,30}$/)
  unitPriceMicros!: string;

  @ApiProperty({ description: 'Instant the rate takes effect (ISO 8601). The row stays in force until superseded.' })
  @IsISO8601()
  effectiveFrom!: string;

  @ApiProperty({ description: 'Human-traceable book label stamped onto everything this row prices.', example: '2026-09-01-commercial-v2' })
  @IsString()
  @MaxLength(120)
  bookVersion!: string;
}
