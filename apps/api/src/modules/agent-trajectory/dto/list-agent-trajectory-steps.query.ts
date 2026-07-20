import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * query for
 * `GET /admin/agent-trajectory/sessions/:sessionId/steps`.
 *
 * Keyset (not offset) pagination — this table grows unbounded. Whitelisted by
 * the global `forbidNonWhitelisted` pipe.
 */
export class ListAgentTrajectoryStepsQuery {
  @ApiPropertyOptional({ description: 'Narrow to a single run\'s per-run seq stream ("" sentinel for non-Temporal sessions).' })
  @IsOptional()
  @IsString()
  runId?: string;

  @ApiPropertyOptional({ description: "Opaque keyset cursor (base64url) from a prior page's nextCursor." })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ type: Number, description: 'Page size (keyset).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @IsOptional()
  @IsString()
  tenantId?: string;
}
