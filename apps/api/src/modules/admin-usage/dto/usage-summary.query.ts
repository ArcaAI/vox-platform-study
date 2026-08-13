import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

/** query for `GET admin/usage/summary`. */
export class UsageSummaryQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM (UTC calendar month). Defaults to the current UTC month.' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be "YYYY-MM"' })
  period?: string;

  @ApiPropertyOptional({ description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @IsOptional()
  @IsString()
  tenantId?: string;
}

/** query for `GET usage/me/summary` — no tenantId (always the caller's own tenant). */
export class MyUsageSummaryQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM (UTC calendar month). Defaults to the current UTC month.' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be "YYYY-MM"' })
  period?: string;
}
