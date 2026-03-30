import { AutoClassMapper, RolePermissionEntity } from '@arcaai/domains';
import { RolePermissionResponse, PaginatedRolePermissionResponse } from './dto';
import { FetchResponse } from '../../../common';

// TODO: Implement this

export class RolePermissionDtoMapper {
  static ToResponse(entity: RolePermissionEntity): RolePermissionResponse {
    return AutoClassMapper(entity, RolePermissionResponse);
  }

  static ToPaginatedResponse({ page, limit, count, data }: FetchResponse<RolePermissionEntity>): PaginatedRolePermissionResponse {
    return new PaginatedRolePermissionResponse({
      page,
      limit,
      count,
      data: data.map((rolePermission) => this.ToResponse(rolePermission)),
    });
  }
}
