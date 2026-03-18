import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { NotificationResponse } from '.';

// TODO: Implement this

export class PaginatedNotificationResponse extends PaginatedResponse<NotificationResponse> {
    @ApiProperty({ type: [NotificationResponse] })
    override readonly data!: readonly NotificationResponse[];
}
