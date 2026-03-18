import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { TenantResponse } from '.';

// TODO: Implement this

export class PaginatedTenantResponse extends PaginatedResponse<TenantResponse> {
    @ApiProperty({ type: [TenantResponse] })
    override readonly data!: readonly TenantResponse[];
}
