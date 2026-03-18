import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { GlobalSettingResponse } from '.';

// TODO: Implement this

export class PaginatedGlobalSettingResponse extends PaginatedResponse<GlobalSettingResponse> {
    @ApiProperty({ type: [GlobalSettingResponse] })
    override readonly data!: readonly GlobalSettingResponse[];
}
