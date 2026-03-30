import { AutoClassMapper, UserProfileEntity } from '@arcaai/domains';
import { UserProfileResponse, PaginatedUserProfileResponse } from './dto';
import { FetchResponse } from '../../../common';

// TODO: Implement this

export class UserProfileDtoMapper {
  static ToResponse(entity: UserProfileEntity): UserProfileResponse {
    return AutoClassMapper(entity, UserProfileResponse);
  }

  static ToPaginatedResponse({ page, limit, count, data }: FetchResponse<UserProfileEntity>): PaginatedUserProfileResponse {
    return new PaginatedUserProfileResponse({
      page,
      limit,
      count,
      data: data.map((userProfile) => this.ToResponse(userProfile)),
    });
  }
}
