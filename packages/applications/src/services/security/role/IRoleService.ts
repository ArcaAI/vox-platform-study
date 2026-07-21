import { EntityId, RoleEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../../common';
import { IBaseService } from '../../../interfaces';
import { CreateRoleRequest, UpdateRoleRequest } from './dto';

export interface IRoleService extends IBaseService {
  create(request: CreateRoleRequest): Promise<RoleEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<RoleEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<RoleEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<RoleEntity>>;
  fetchById(id: EntityId): Promise<RoleEntity>;
  update(id: EntityId, request: UpdateRoleRequest): Promise<RoleEntity>;
  deleteById(id: EntityId): Promise<RoleEntity>;
}
export const IRoleService = Symbol('IRoleService');
