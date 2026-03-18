import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../../common';
import { PermissionResponse } from '.';

// TODO: Implement this

export class PaginatedPermissionResponse extends PaginatedResponse<PermissionResponse> {
    @ApiProperty({ type: [PermissionResponse] })
    override readonly data!: readonly PermissionResponse[];
}
