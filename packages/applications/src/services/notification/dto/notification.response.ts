import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../common';
import { NotificationType } from '@arcaai/domains';
import { JsonValue } from '@arcaai/domains';

export class NotificationResponse extends BaseResponse {
  @ApiProperty({ description: 'Title of the notification' })
  title!: string;

  @ApiProperty({
    description: 'Message text of the notification',
    required: false,
  })
  message?: string;

  @ApiProperty({
    description: 'Additional data for the notification',
    required: false,
  })
  data?: JsonValue;

  @ApiProperty({ description: 'Type of notification' })
  type!: NotificationType;

  @ApiProperty({ description: 'Read status of the notification' })
  read: boolean = false;

  @ApiProperty({ description: 'Resource subscription ID', required: false })
  resourceSubscriptionId?: string;

  @ApiProperty({ description: 'Target user ID' })
  targetUserId!: string;

  constructor(init: NotificationResponse & BaseResponseProps) {
    super(init);
    this.title = init.title;
    this.message = init.message;
    this.data = init.data;
    this.type = init.type;
    this.read = init.read;
    this.resourceSubscriptionId = init.resourceSubscriptionId;
    this.targetUserId = init.targetUserId;
  }
}
