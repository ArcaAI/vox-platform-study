import { AutoClassMapper, PermissionEntity } from '@arcaai/domains';
import { PermissionResponse, PaginatedPermissionResponse } from './dto';
import { FetchResponse } from '../../../common';

// TODO: Implement this

export class PermissionDtoMapper {
    static ToResponse(entity: PermissionEntity): PermissionResponse {
        return AutoClassMapper(entity, PermissionResponse);
    }

    static ToPaginatedResponse({
        page,
        limit,
        count,
        data
    }: FetchResponse<PermissionEntity>): PaginatedPermissionResponse {
        return new PaginatedPermissionResponse({
            page,
            limit,
            count,
            data: data.map((permission) => this.ToResponse(permission))
        });
    }
}
