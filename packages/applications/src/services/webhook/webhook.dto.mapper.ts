import { AutoClassMapper, WebhookEntity } from '@arcaai/domains';
import { WebhookResponse, PaginatedWebhookResponse } from './dto';
import { FetchResponse } from '../../common';

// TODO: Implement this

export class WebhookDtoMapper {
    static ToResponse(entity: WebhookEntity): WebhookResponse {
        return AutoClassMapper(entity, WebhookResponse);
    }

    static ToPaginatedResponse({
        page,
        limit,
        count,
        data
    }: FetchResponse<WebhookEntity>): PaginatedWebhookResponse {
        return new PaginatedWebhookResponse({
            page,
            limit,
            count,
            data: data.map((webhook) => this.ToResponse(webhook))
        });
    }
}
