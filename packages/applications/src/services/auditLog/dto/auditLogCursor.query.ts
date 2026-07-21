import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { AuditAction, ResourceType } from '@arcaai/domains';
import { CursorQuery } from '../../../common';

/**
 * Query-param DTO for the cursor (keyset) audit-log list.
 *
 * The cursor counterpart of {@link AuditLogQuery}: extends {@link CursorQuery}
 * (`cursor`/`limit`) and carries the same A8 filters, pushed to the repository
 * `where` clause (never applied in-memory). The offset-only `page`/`search`/
 * `sort` knobs are intentionally absent — keyset ordering is fixed to
 * `(createdAt, id)` DESC.
 */
export class AuditLogCursorQuery extends CursorQuery {
  @ApiPropertyOptional({
    description: 'Inclusive lower bound for createdAt (ISO-8601).',
    example: '2026-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'Inclusive upper bound for createdAt (ISO-8601).',
    example: '2026-01-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ enum: AuditAction, description: 'Filter by audit action.' })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({ enum: ResourceType, description: 'Filter by resource type.' })
  @IsOptional()
  @IsEnum(ResourceType)
  resourceType?: ResourceType;

  @ApiPropertyOptional({ description: 'Filter by the acting (responsible) user id.' })
  @IsOptional()
  @IsString()
  userId?: string;
}
