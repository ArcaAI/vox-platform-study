import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';
import { AgentSessionKind } from '@arcaai/domains';

/**
 * TASK-510 Phase 2D — query for `GET /admin/agent-trajectory/sessions`.
 *
 * Whitelisted (global `forbidNonWhitelisted` pipe): only these params are
 * accepted. `tenantId` is the platform-admin cross-tenant override used by
 * every read on this admin plane (tenant admins are pinned to their own tenant).
 */
export class ListAgentTrajectorySessionsQuery {
  @ApiPropertyOptional({ description: 'Narrow to a single consultation.' })
  @IsOptional()
  @IsString()
  consultationId?: string;

  @ApiPropertyOptional({ enum: AgentSessionKind, description: 'Narrow to a session kind (LIVE_DOC | HARNESS_DOC | SUMMARY_JOB | EVAL_RUN).' })
  @IsOptional()
  @IsEnum(AgentSessionKind)
  kind?: AgentSessionKind;

  @ApiPropertyOptional({ description: 'Inclusive lower bound on createdAt (ISO-8601 instant).' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Inclusive upper bound on createdAt (ISO-8601 instant).' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ type: Number, description: '1-based page into the distinct-session list.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ type: Number, description: 'Page size (1–100).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @IsOptional()
  @IsString()
  tenantId?: string;
}
