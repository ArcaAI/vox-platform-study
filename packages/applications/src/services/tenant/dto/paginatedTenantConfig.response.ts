import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { TenantConfigResponse } from './tenantConfig.response';

export class PaginatedTenantConfigResponse extends PaginatedResponse<TenantConfigResponse> {
    @ApiProperty({ type: [TenantConfigResponse] })
    override readonly data!: readonly TenantConfigResponse[];
}
