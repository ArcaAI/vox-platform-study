import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Query for `GET /admin/workflow-runs`.
 *
 * Keyset (not offset) pagination. Whitelisted by the global
 * `forbidNonWhitelisted` pipe — every accepted field is declared here.
 */
export class ListWorkflowRunsQuery {
  @ApiPropertyOptional({ description: 'WorkflowDefinition.slug — the stable lineage key.' })
  @IsOptional()
  @IsString()
  workflowSlug?: string;

  @ApiPropertyOptional({ description: 'WorkflowDefinition.id of a specific pinned version.' })
  @IsOptional()
  @IsString()
  workflowVersionId?: string;

  @ApiPropertyOptional({ description: 'RUNNING | COMPLETED | FAILED | CANCELED | TIMED_OUT.' })
  @IsOptional()
  @IsIn(['RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT'])
  status?: string;

  @ApiPropertyOptional({ description: 'consultation open | api invoke | webhook | schedule.' })
  @IsOptional()
  @IsString()
  trigger?: string;

  @ApiPropertyOptional({ description: 'Inclusive lower bound on startedAt (ISO-8601 instant).' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Inclusive upper bound on startedAt (ISO-8601 instant).' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Include TASK-721 Workbench sandbox runs. Defaults to false.', type: Boolean })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeSandbox?: boolean;

  @ApiPropertyOptional({ description: "Opaque keyset cursor (base64url) from a prior page's nextCursor." })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ type: Number, description: 'Page size (keyset).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
