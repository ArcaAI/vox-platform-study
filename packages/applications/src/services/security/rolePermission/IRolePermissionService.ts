import { EntityId, RolePermissionEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../../common';
import { IBaseService } from '../../../interfaces';
import { CreateRolePermissionRequest, UpdateRolePermissionRequest } from './dto';

export interface IRolePermissionService extends IBaseService {
  createRoleAssignment(request: CreateRolePermissionRequest): Promise<RolePermissionEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<RolePermissionEntity>>;
  fetchAllByRoleId(props: PaginatedQuery & { roleId: EntityId }): Promise<FetchResponse<RolePermissionEntity>>;
  fetchById(id: EntityId): Promise<RolePermissionEntity>;
  update(id: EntityId, request: UpdateRolePermissionRequest): Promise<RolePermissionEntity>;
  deleteById(id: EntityId): Promise<RolePermissionEntity>;
}
export const IRolePermissionService = Symbol('IRolePermissionService');
