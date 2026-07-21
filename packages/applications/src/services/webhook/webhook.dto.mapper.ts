import { AutoClassMapper, WebhookEntity, WebhookRunHistoryEntity } from '@arcaai/domains';
import { WebhookResponse, PaginatedWebhookResponse, WebhookRunHistoryResponse, PaginatedWebhookRunHistoryResponse } from './dto';
import { FetchResponse } from '../../common';

export class WebhookDtoMapper {
  static ToResponse(entity: WebhookEntity): WebhookResponse {
    return AutoClassMapper(entity, WebhookResponse);
  }

  static ToPaginatedResponse({ page, limit, count, data }: FetchResponse<WebhookEntity>): PaginatedWebhookResponse {
    return new PaginatedWebhookResponse({
      page,
      limit,
      count,
      data: data.map((webhook) => this.ToResponse(webhook)),
    });
  }

  // TASK-419 item 2 — delivery-log projections.
  static ToRunHistoryResponse(entity: WebhookRunHistoryEntity): WebhookRunHistoryResponse {
    return AutoClassMapper(entity, WebhookRunHistoryResponse);
  }

  static ToPaginatedRunHistoryResponse({ page, limit, count, data }: FetchResponse<WebhookRunHistoryEntity>): PaginatedWebhookRunHistoryResponse {
    return new PaginatedWebhookRunHistoryResponse({
      page,
      limit,
      count,
      data: data.map((run) => this.ToRunHistoryResponse(run)),
    });
  }
}
