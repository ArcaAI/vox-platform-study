import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString } from 'class-validator';

/**
 * TASK-509 follow-up — query for
 * `GET /admin/agent-trajectory/metrics/generation`.
 *
 * Whitelisted (global `forbidNonWhitelisted` pipe). When `from`/`to` are both
 * omitted the service defaults to the last 7 days and hard-caps scanned rows.
 */
export class AggregateGenerationMetricsQuery {
  @ApiPropertyOptional({ description: 'Narrow to a single consultation.' })
  @IsOptional()
  @IsString()
  consultationId?: string;

  @ApiPropertyOptional({ description: 'Inclusive lower bound on createdAt (ISO-8601 instant).' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Inclusive upper bound on createdAt (ISO-8601 instant).' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @IsOptional()
  @IsString()
  tenantId?: string;
}
