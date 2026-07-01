import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginatedQuery } from '@arcaai/applications';
import type { UserExportFormat } from '../user-export.service';

/**
 * TASK-388 #10 — query for `GET /admin/users/export`. Extends the shared
 * `PaginatedQuery` so the export honours the SAME CSV filters/sort/search as the
 * Users list; `format` selects the serialization (defaults to `csv`).
 */
export class ExportUsersQuery extends PaginatedQuery {
  @ApiPropertyOptional({ description: 'Export format', enum: ['csv', 'xlsx', 'pdf'], default: 'csv' })
  @IsOptional()
  @IsIn(['csv', 'xlsx', 'pdf'])
  format?: UserExportFormat;
}
