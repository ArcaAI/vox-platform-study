import { EntityId, UserProfileEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../../common';
import { IBaseService } from '../../../interfaces';
import { CreateUserProfileRequest, UpdateUserProfileRequest } from './dto';

export interface IUserProfileService extends IBaseService {
  create(request: CreateUserProfileRequest): Promise<UserProfileEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserProfileEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserProfileEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserProfileEntity>>;
  fetchById(id: EntityId): Promise<UserProfileEntity>;
  /** Fetch the profile row for a user, or null when none exists yet. */
  getByUserId(userId: string): Promise<UserProfileEntity | null>;
  /** Create-or-update the profile keyed by userId. */
  upsertByUserId(userId: string, request: UpdateUserProfileRequest): Promise<UserProfileEntity>;
  update(id: EntityId, request: UpdateUserProfileRequest): Promise<UserProfileEntity>;
  deleteById(id: EntityId): Promise<UserProfileEntity>;
}
export const IUserProfileService = Symbol('IUserProfileService');
