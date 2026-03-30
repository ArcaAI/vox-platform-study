import { AutoClassMapper, RoleEntity } from '@arcaai/domains';
import { RoleResponse, PaginatedRoleResponse } from './dto';
import { FetchResponse } from '../../../common';

// TODO: Implement this

export class RoleDtoMapper {
  static ToResponse(entity: RoleEntity): RoleResponse {
    return AutoClassMapper(entity, RoleResponse);
  }

  static ToPaginatedResponse({ page, limit, count, data }: FetchResponse<RoleEntity>): PaginatedRoleResponse {
    return new PaginatedRoleResponse({
      page,
      limit,
      count,
      data: data.map((role) => this.ToResponse(role)),
    });
  }
}
