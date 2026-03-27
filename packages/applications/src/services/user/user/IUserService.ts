import { EntityId, UserEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../../common';
import { IBaseService } from '../../../interfaces';
import { CreateUserRequest, CreateOAuthUserRequest, UpdateUserRequest } from './dto';

// TODO: Implement this

export interface IUserService extends IBaseService {
  create(request: CreateUserRequest): Promise<UserEntity>;
  createExternalUser(request: CreateOAuthUserRequest): Promise<UserEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserEntity>>;
  fetchById(id: EntityId): Promise<UserEntity>;
  fetchByExternalId(externalId: string): Promise<UserEntity>;
  update(id: EntityId, request: UpdateUserRequest): Promise<UserEntity>;
  deleteById(id: EntityId): Promise<UserEntity>;
}
export const IUserService = Symbol('IUserService');
