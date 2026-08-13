import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiCapability, AiUsageUnit } from '@arcaai/domains';
import { IsEnum, IsISO8601, IsIn, IsOptional, IsString } from 'class-validator';

/** query for `GET admin/usage/timeseries`. */
export class UsageTimeseriesQuery {
  @ApiProperty({ enum: AiCapability })
  @IsEnum(AiCapability)
  capability!: AiCapability;

  @ApiProperty({ enum: AiUsageUnit })
  @IsEnum(AiUsageUnit)
  unit!: AiUsageUnit;

  @ApiProperty({ enum: ['day', 'hour'] })
  @IsIn(['day', 'hour'])
  granularity!: 'day' | 'hour';

  @ApiProperty({ description: 'Inclusive lower bound, ISO-8601 instant.' })
  @IsISO8601()
  from!: string;

  @ApiProperty({ description: 'Exclusive upper bound, ISO-8601 instant.' })
  @IsISO8601()
  to!: string;

  @ApiPropertyOptional({ description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @IsOptional()
  @IsString()
  tenantId?: string;
}
