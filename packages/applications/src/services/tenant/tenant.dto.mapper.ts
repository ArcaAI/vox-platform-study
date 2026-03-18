import { AutoClassMapper, TenantEntity } from '@arcaai/domains';
import { TenantResponse, PaginatedTenantResponse } from './dto';
import { FetchResponse } from '../../common';

// TODO: Implement this

export class TenantDtoMapper {
    static ToResponse(entity: TenantEntity): TenantResponse {
        return AutoClassMapper(entity, TenantResponse);
    }

    static ToPaginatedResponse({
        page,
        limit,
        count,
        data
    }: FetchResponse<TenantEntity>): PaginatedTenantResponse {
        return new PaginatedTenantResponse({
            page,
            limit,
            count,
            data: data.map((tenant) => this.ToResponse(tenant))
        });
    }
}
