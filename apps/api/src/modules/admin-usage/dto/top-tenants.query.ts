import { ApiPropertyOptional } from '@nestjs/swagger';
import { AiCapability } from '@arcaai/domains';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

/** query for `GET admin/usage/top-tenants` — GLOBAL_ADMIN-only cross-tenant rollup (TASK-615 WS-J). */
export class TopTenantsQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM (UTC calendar month). Defaults to the current UTC month.' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be "YYYY-MM"' })
  period?: string;

  @ApiPropertyOptional({ enum: ['cost'], description: 'Ranking metric. Only "cost" (rollup rated cost) is supported today.' })
  @IsOptional()
  @Matches(/^cost$/, { message: 'metric must be "cost"' })
  metric?: 'cost';

  @ApiPropertyOptional({ type: Number, description: 'Top-N cap, 1-50.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ enum: AiCapability, description: 'Narrow the ranking to one capability.' })
  @IsOptional()
  @IsEnum(AiCapability)
  capability?: AiCapability;
}
