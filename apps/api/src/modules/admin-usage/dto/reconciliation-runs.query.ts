import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Query for `GET admin/usage/reconciliation/runs` — the provider-reconciliation audit trail. */
export class ReconciliationRunsQuery {
  @ApiPropertyOptional({ description: 'Restrict to one vendor slug, e.g. "openai".' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  provider?: string;

  @ApiPropertyOptional({ type: Boolean, description: 'Only runs that breached the drift threshold — the "needs investigating" view.' })
  @IsOptional()
  // A query string carries "true"/"false" as text; the global pipe's implicit
  // conversion does not cover booleans, so convert explicitly.
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() === 'true' : value))
  @IsBoolean()
  breachedOnly?: boolean;

  @ApiPropertyOptional({ description: 'Inclusive ISO-8601 lower bound on `runAt`.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'EXCLUSIVE ISO-8601 upper bound on `runAt`.' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ type: Number, description: 'Page size, 1-500. The repository caps at 500 regardless.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
