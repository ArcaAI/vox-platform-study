import { PaginatedResponse } from '../../../common';
import { ApiProperty } from '@nestjs/swagger';
import { AuditLogResponse } from '.';

export class PaginatedAuditLogResponse extends PaginatedResponse<AuditLogResponse> {
    @ApiProperty({ type: [AuditLogResponse] })
    override readonly data!: readonly AuditLogResponse[];
}
