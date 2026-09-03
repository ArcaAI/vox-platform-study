import { AutoClassMapper, WebhookEntity, WebhookRunHistoryEntity } from '@arcaai/domains';
import { WebhookResponse, PaginatedWebhookResponse, WebhookRunHistoryResponse, PaginatedWebhookRunHistoryResponse } from './dto';
import { FetchResponse } from '../../common';

export class WebhookDtoMapper {
  static ToResponse(entity: WebhookEntity): WebhookResponse {
    // `hashedSecret` is deliberately never mapped onto `WebhookResponse` (the
    // class carries no such field) — only its presence/absence, as
    // `hasSecret`. See / webhook.response.ts.
    return AutoClassMapper(entity, WebhookResponse, {
      hasSecret: (source) => Boolean(source.hashedSecret),
    });
  }

  static ToPaginatedResponse({ page, limit, count, data }: FetchResponse<WebhookEntity>): PaginatedWebhookResponse {
    return new PaginatedWebhookResponse({
      page,
      limit,
      count,
      data: data.map((webhook) => this.ToResponse(webhook)),
    });
  }

  // Delivery-log projections.
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
