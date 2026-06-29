import { AuditLogEntity, AutoClassMapper } from '@arcaai/domains';
import { AuditLogResponse, PaginatedAuditLogResponse, CursorPaginatedAuditLogResponse } from './dto';
import { ResponsibleUserMap } from './IAuditLogService';
import { FetchResponse, CursorPage } from '../../common';

/**
 * TASK-328 A8 — CSV column order. Kept as a single source of truth so the
 * header row and each data row stay aligned.
 */
const CSV_COLUMNS = [
  'id',
  'createdAt',
  'action',
  'resourceType',
  'resourceId',
  'responsibleUserId',
  'responsibleUserName',
  'responsibleUserEmail',
  'responsibleIp',
  'eventType',
  'success',
  'data',
] as const;

/**
 * RFC 4180 field escaping: wrap in double quotes (and double any embedded
 * quote) whenever the value contains a comma, quote, or newline. Everything
 * else passes through verbatim.
 */
function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export class AuditLogDtoMapper {
  static ToResponse(entity: AuditLogEntity, responsibleUsers?: ResponsibleUserMap): AuditLogResponse {
    const response = AutoClassMapper(entity, AuditLogResponse);
    const userId = entity.responsibleUserId;
    response.responsibleUser = userId ? (responsibleUsers?.[userId] ?? null) : null;
    return response;
  }

  static ToPaginatedResponse(
    { page, limit, count, data }: FetchResponse<AuditLogEntity>,
    responsibleUsers?: ResponsibleUserMap,
  ): PaginatedAuditLogResponse {
    return new PaginatedAuditLogResponse({
      page,
      limit,
      count,
      data: data.map((entity) => this.ToResponse(entity, responsibleUsers)),
    });
  }

  /**
   * TASK-373 — map a cursor (keyset) page to its response envelope, preserving
   * the opaque `nextCursor`/`hasMore` cursor metadata and enriching each row
   * with its acting user (same as {@link ToPaginatedResponse}).
   */
  static ToCursorResponse(
    { data, nextCursor, hasMore, limit }: CursorPage<AuditLogEntity>,
    responsibleUsers?: ResponsibleUserMap,
  ): CursorPaginatedAuditLogResponse {
    return new CursorPaginatedAuditLogResponse({
      nextCursor,
      hasMore,
      limit,
      data: data.map((entity) => this.ToResponse(entity, responsibleUsers)),
    });
  }

  /**
   * TASK-328 A8 — serialise a filtered audit-log set to CSV text. The acting
   * user name/email are flattened into dedicated columns and the `data` JSON
   * blob is stringified into a single (escaped) cell so the export is a
   * faithful, spreadsheet-friendly snapshot of the table.
   *
   * OB-07 (TASK-336) — when `options.includeTenant` is set (cross-tenant /
   * super-admin "global" export), a trailing `tenantId` column is appended so
   * each row keeps its tenant attribution. Tenant-scoped exports omit it (every
   * row belongs to the caller's own tenant, so the column would be noise).
   */
  static ToCsv(rows: AuditLogEntity[], responsibleUsers: ResponsibleUserMap = {}, options: { includeTenant?: boolean } = {}): string {
    const columns: string[] = options.includeTenant ? [...CSV_COLUMNS, 'tenantId'] : [...CSV_COLUMNS];
    const lines: string[] = [columns.join(',')];

    for (const row of rows) {
      const user = row.responsibleUserId ? responsibleUsers[row.responsibleUserId] : undefined;
      const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : (row.createdAt ?? '');

      const cells: Record<string, unknown> = {
        id: row.id,
        createdAt,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId ?? '',
        responsibleUserId: row.responsibleUserId ?? '',
        responsibleUserName: user?.displayName ?? '',
        responsibleUserEmail: user?.email ?? '',
        responsibleIp: row.responsibleIp ?? '',
        eventType: row.eventType ?? '',
        success: row.success === null || row.success === undefined ? '' : String(row.success),
        data: row.data === null || row.data === undefined ? '' : JSON.stringify(row.data),
      };

      if (options.includeTenant) {
        cells.tenantId = row.tenantId ?? '';
      }

      lines.push(columns.map((col) => escapeCsvField(cells[col])).join(','));
    }

    return lines.join('\n');
  }
}
