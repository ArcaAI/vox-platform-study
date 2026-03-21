import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../../common';
import { MediaResponse } from '.';

// TODO: Implement this

export class PaginatedMediaResponse extends PaginatedResponse<MediaResponse> {
    @ApiProperty({ type: [MediaResponse] })
    override readonly data!: readonly MediaResponse[];
}
