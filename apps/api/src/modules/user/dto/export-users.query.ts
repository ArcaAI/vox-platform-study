import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { PaginatedQuery } from '@arcaai/applications';
import type { UserExportFormat } from '../user-export.service';

/**
 * Query for `GET /admin/users/export`. Extends the shared `PaginatedQuery` so
 * the export honours the SAME CSV filters/sort/search as the Users list;
 * `format` selects the serialization (defaults to `csv`).
 */
export class ExportUsersQuery extends PaginatedQuery {
  @ApiPropertyOptional({ description: 'Export format', enum: ['csv', 'xlsx', 'pdf'], default: 'csv' })
  @IsOptional()
  @IsIn(['csv', 'xlsx', 'pdf'])
  format?: UserExportFormat;

  /**
   * Scope the export to ONE tenant. Backs the users list's in-page
   * tenant filter (users have no `tenantId` column, so the CSV filter grammar
   * cannot express the membership join). Guarded by the same
   * `assertCanReadTenant` as the by-tenant list route: SUPER_ADMIN may pass
   * any tenant, everyone else only their own CLS tenant.
   */
  @ApiPropertyOptional({ description: 'Scope the export to one tenant (membership-based; SUPER_ADMIN may pass any tenant)' })
  @IsOptional()
  @IsString()
  tenantId?: string;
}
