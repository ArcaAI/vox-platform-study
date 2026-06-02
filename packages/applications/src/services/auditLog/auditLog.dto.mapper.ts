import { AuditLogEntity, AutoClassMapper } from '@arcaai/domains';
import { AuditLogResponse, PaginatedAuditLogResponse } from './dto';
import { ResponsibleUserMap } from './IAuditLogService';
import { FetchResponse } from '../../common';

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
   * TASK-328 A8 — serialise a filtered audit-log set to CSV text. The acting
   * user name/email are flattened into dedicated columns and the `data` JSON
   * blob is stringified into a single (escaped) cell so the export is a
   * faithful, spreadsheet-friendly snapshot of the table.
   */
  static ToCsv(rows: AuditLogEntity[], responsibleUsers: ResponsibleUserMap = {}): string {
    const lines: string[] = [CSV_COLUMNS.join(',')];

    for (const row of rows) {
      const user = row.responsibleUserId ? responsibleUsers[row.responsibleUserId] : undefined;
      const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : (row.createdAt ?? '');

      const cells: Record<(typeof CSV_COLUMNS)[number], unknown> = {
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

      lines.push(CSV_COLUMNS.map((col) => escapeCsvField(cells[col])).join(','));
    }

    return lines.join('\n');
  }
}
