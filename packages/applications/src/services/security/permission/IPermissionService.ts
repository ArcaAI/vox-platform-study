import { EntityId, PermissionEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../../common';
import { IBaseService } from '../../../interfaces';
import { CreatePermissionRequest, UpdatePermissionRequest } from './dto';

export interface IPermissionService extends IBaseService {
  create(request: CreatePermissionRequest): Promise<PermissionEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<PermissionEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<PermissionEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<PermissionEntity>>;
  fetchById(id: EntityId): Promise<PermissionEntity>;
  update(id: EntityId, request: UpdatePermissionRequest): Promise<PermissionEntity>;
  deleteById(id: EntityId): Promise<PermissionEntity>;
}
export const IPermissionService = Symbol('IPermissionService');
