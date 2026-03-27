import { EntityId, UserProfileEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../../common';
import { IBaseService } from '../../../interfaces';
import { CreateUserProfileRequest, UpdateUserProfileRequest } from './dto';

// TODO: Implement this

export interface IUserProfileService extends IBaseService {
  create(request: CreateUserProfileRequest): Promise<UserProfileEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserProfileEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserProfileEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserProfileEntity>>;
  fetchById(id: EntityId): Promise<UserProfileEntity>;
  update(id: EntityId, request: UpdateUserProfileRequest): Promise<UserProfileEntity>;
  deleteById(id: EntityId): Promise<UserProfileEntity>;
}
export const IUserProfileService = Symbol('IUserProfileService');
