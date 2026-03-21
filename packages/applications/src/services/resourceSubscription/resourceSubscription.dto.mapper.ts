import { AutoClassMapper, ResourceSubscriptionEntity } from '@arcaai/domains';
import {
    ResourceSubscriptionResponse,
    PaginatedResourceSubscriptionResponse
} from './dto';
import { FetchResponse } from '../../common';

// TODO: Implement this

export class ResourceSubscriptionDtoMapper {
    static ToResponse(
        entity: ResourceSubscriptionEntity
    ): ResourceSubscriptionResponse {
        return AutoClassMapper(entity, ResourceSubscriptionResponse);
    }

    static ToPaginatedResponse({
        page,
        limit,
        count,
        data
    }: FetchResponse<ResourceSubscriptionEntity>): PaginatedResourceSubscriptionResponse {
        return new PaginatedResourceSubscriptionResponse({
            page,
            limit,
            count,
            data: data.map((resourceSubscription) =>
                this.ToResponse(resourceSubscription)
            )
        });
    }
}
