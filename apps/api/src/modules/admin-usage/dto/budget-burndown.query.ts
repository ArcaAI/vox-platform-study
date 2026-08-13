import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/** query for `GET usage/me/burndown`. */
export class BudgetBurndownQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM (UTC calendar month). Defaults to the current UTC month.' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be "YYYY-MM"' })
  period?: string;
}
