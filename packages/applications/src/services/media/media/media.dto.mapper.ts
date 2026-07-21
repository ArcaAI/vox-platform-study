import { AutoClassMapper, MediaEntity } from '@arcaai/domains';
import { MediaResponse, PaginatedMediaResponse } from './dto';
import { FetchResponse } from '../../../common';

export class MediaDtoMapper {
  static ToResponse(entity: MediaEntity): MediaResponse {
    return AutoClassMapper(entity, MediaResponse);
  }

  static ToPaginatedResponse({ page, limit, count, data }: FetchResponse<MediaEntity>): PaginatedMediaResponse {
    return new PaginatedMediaResponse({
      page,
      limit,
      count,
      data: data.map((media) => this.ToResponse(media)),
    });
  }
}
