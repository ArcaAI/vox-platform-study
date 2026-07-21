import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { NotificationResponse } from '.';

export class PaginatedNotificationResponse extends PaginatedResponse<NotificationResponse> {
  @ApiProperty({ type: [NotificationResponse] })
  override readonly data!: readonly NotificationResponse[];
}
