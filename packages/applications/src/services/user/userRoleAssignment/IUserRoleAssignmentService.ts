import { EntityId, UserRoleAssignmentEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../../common';
import { IBaseService } from '../../../interfaces';
import { CreateUserRoleAssignmentRequest, UpdateUserRoleAssignmentRequest } from './dto';

// TODO: Implement this

export interface IUserRoleAssignmentService extends IBaseService {
  create(request: CreateUserRoleAssignmentRequest): Promise<UserRoleAssignmentEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchAllByUserId(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchById(id: EntityId): Promise<UserRoleAssignmentEntity>;
  update(id: EntityId, request: UpdateUserRoleAssignmentRequest): Promise<UserRoleAssignmentEntity>;
  deleteById(id: EntityId): Promise<UserRoleAssignmentEntity>;
}
export const IUserRoleAssignmentService = Symbol('IUserRoleAssignmentService');
