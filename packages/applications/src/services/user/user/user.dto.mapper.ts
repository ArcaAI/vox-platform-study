import { AutoClassMapper, UserEntity } from '@arcaai/domains';
import { UserResponse, PaginatedUserResponse } from './dto';
import { FetchResponse } from '../../../common';
import { UserRoleAssignmentDtoMapper } from '../userRoleAssignment/userRoleAssignment.dto.mapper';

// TODO: Implement this

export class UserDtoMapper {
  static ToResponse(entity: UserEntity): UserResponse {
    const response = AutoClassMapper(entity, UserResponse);
    if (entity.UserRoleAssignments) {
      response.UserRoleAssignments = entity.UserRoleAssignments.map((a) => UserRoleAssignmentDtoMapper.ToResponse(a));
    }
    return response;
  }

  static ToPaginatedResponse({ page, limit, count, data }: FetchResponse<UserEntity>): PaginatedUserResponse {
    return new PaginatedUserResponse({
      page,
      limit,
      count,
      data: data.map((user) => this.ToResponse(user)),
    });
  }
}
