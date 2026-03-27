import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../common';
import { JsonValue } from '@arcaai/domains';

export class WebhookResponse extends BaseResponse {
  @ApiProperty({ description: 'Name of the webhook' })
  name!: string;

  @ApiProperty({ description: 'URL of the webhook endpoint' })
  url!: string;

  @ApiProperty({
    description: 'Hashed secret for webhook authentication',
    required: false,
  })
  hashedSecret?: string;

  @ApiProperty({ description: 'Resource type name' })
  resourceTypeName!: string;

  @ApiProperty({ description: 'Resource ID', required: false })
  resourceId?: string;

  @ApiProperty({ description: 'Subscription metadata', required: false })
  subscriptionMetadata?: JsonValue;

  constructor(init: WebhookResponse & BaseResponseProps) {
    super(init);
    this.name = init.name;
    this.url = init.url;
    this.hashedSecret = init.hashedSecret;
    this.resourceTypeName = init.resourceTypeName;
    this.resourceId = init.resourceId;
    this.subscriptionMetadata = init.subscriptionMetadata;
  }
}
