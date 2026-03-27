import { AutoClassMapper, UserMediaEntity } from '@arcaai/domains';
import { UserMediaResponse, PaginatedUserMediaResponse } from './dto';
import { FetchResponse } from '../../../common';

// TODO: Implement this

export class UserMediaDtoMapper {
  static ToResponse(entity: UserMediaEntity): UserMediaResponse {
    return AutoClassMapper(entity, UserMediaResponse);
  }

  static ToPaginatedResponse({ page, limit, count, data }: FetchResponse<UserMediaEntity>): PaginatedUserMediaResponse {
    return new PaginatedUserMediaResponse({
      page,
      limit,
      count,
      data: data.map((userMedia) => this.ToResponse(userMedia)),
    });
  }
}
