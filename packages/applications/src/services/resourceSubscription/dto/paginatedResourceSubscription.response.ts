import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { ResourceSubscriptionResponse } from '.';

// TODO: Implement this

export class PaginatedResourceSubscriptionResponse extends PaginatedResponse<ResourceSubscriptionResponse> {
    @ApiProperty({ type: [ResourceSubscriptionResponse] })
    override readonly data!: readonly ResourceSubscriptionResponse[];
}
