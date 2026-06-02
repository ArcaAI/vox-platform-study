import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { AuditAction, ResourceType } from '@arcaai/domains';
import { PaginatedQuery } from '../../../common';

/**
 * TASK-328 A8 — query-param DTO for the filtered audit-log list + CSV export.
 *
 * Extends {@link PaginatedQuery} (page/limit/sort) and adds the audit-specific
 * filters that are pushed to the repository `where` clause (NOT applied
 * in-memory): a `from`/`to` `createdAt` range, `action`, `resourceType`, and
 * an optional `userId` (matched against `responsibleUserId`).
 *
 * `from`/`to` are ISO-8601 strings; the UI sends start-of-day / end-of-day
 * boundaries so the service can build an inclusive `gte`/`lte` range verbatim.
 */
export class AuditLogQuery extends PaginatedQuery {
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

  @ApiPropertyOptional({
    enum: AuditAction,
    description: 'Filter by audit action.',
  })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({
    enum: ResourceType,
    description: 'Filter by resource type.',
  })
  @IsOptional()
  @IsEnum(ResourceType)
  resourceType?: ResourceType;

  @ApiPropertyOptional({
    description: 'Filter by the acting (responsible) user id.',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}
