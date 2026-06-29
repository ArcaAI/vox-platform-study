import { CursorPaginatedResponse } from '../../../common';
import { ApiProperty } from '@nestjs/swagger';
import { AuditLogResponse } from '.';

/**
 * TASK-373 — cursor (keyset) response envelope for the audit-log admin list.
 * The cursor counterpart of {@link PaginatedAuditLogResponse}.
 */
export class CursorPaginatedAuditLogResponse extends CursorPaginatedResponse<AuditLogResponse> {
  @ApiProperty({ type: [AuditLogResponse] })
  override readonly data!: readonly AuditLogResponse[];
}
