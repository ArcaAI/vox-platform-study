import { ApiProperty } from '@nestjs/swagger';
import { JsonValue, WebhookRunStatus } from '@arcaai/domains';
import { BaseResponse, BaseResponseProps, PaginatedResponse } from '../../../common';

/**
 * One webhook delivery attempt — read projection of
 * `WebhookRunHistory`. Rows carry no tenantId: tenancy is enforced through
 * the parent webhook on the service read path.
 */
export class WebhookRunHistoryResponse extends BaseResponse {
  @ApiProperty({ description: 'Parent webhook id.' })
  webhookId!: string;

  @ApiProperty({ description: 'Delivery outcome.', enum: WebhookRunStatus })
  status!: WebhookRunStatus;

  @ApiProperty({ description: 'Receiver response payload (free-form JSON).', required: false })
  response?: JsonValue;

  // NOTE: `responeStatusCode` mirrors the (misspelled) Prisma column name — a
  // rename is a schema migration owned by a future ticket, not this surface.
  @ApiProperty({ description: 'HTTP status code returned by the receiver.', required: false })
  responeStatusCode?: number;

  @ApiProperty({ description: 'Row version.', example: 1 })
  version!: number;

  constructor(init: WebhookRunHistoryResponse & BaseResponseProps) {
    super(init);
    this.webhookId = init.webhookId;
    this.status = init.status;
    this.response = init.response;
    this.responeStatusCode = init.responeStatusCode;
    this.version = init.version;
  }
}

/** Paginated webhook delivery log. */
export class PaginatedWebhookRunHistoryResponse extends PaginatedResponse<WebhookRunHistoryResponse> {
  @ApiProperty({ type: [WebhookRunHistoryResponse] })
  override readonly data!: readonly WebhookRunHistoryResponse[];
}
