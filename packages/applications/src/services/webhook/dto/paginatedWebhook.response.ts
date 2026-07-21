import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { WebhookResponse } from '.';

export class PaginatedWebhookResponse extends PaginatedResponse<WebhookResponse> {
  @ApiProperty({ type: [WebhookResponse] })
  override readonly data!: readonly WebhookResponse[];
}
