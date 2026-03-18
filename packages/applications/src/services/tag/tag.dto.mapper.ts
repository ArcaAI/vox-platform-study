import { AutoClassMapper, TagEntity } from '@arcaai/domains';
import { TagResponse, PaginatedTagResponse } from './dto';
import { FetchResponse } from '../../common';

// TODO: Implement this

export class TagDtoMapper {
    static ToResponse(entity: TagEntity): TagResponse {
        return AutoClassMapper(entity, TagResponse);
    }

    static ToPaginatedResponse({
        page,
        limit,
        count,
        data
    }: FetchResponse<TagEntity>): PaginatedTagResponse {
        return new PaginatedTagResponse({
            page,
            limit,
            count,
            data: data.map((tag) => this.ToResponse(tag))
        });
    }
}
