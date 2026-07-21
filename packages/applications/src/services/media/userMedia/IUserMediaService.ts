import { EntityId, UserMediaEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../../common';
import { IBaseService } from '../../../interfaces';
import { CreateUserMediaRequest, UpdateUserMediaRequest } from './dto';

export interface IUserMediaService extends IBaseService {
  create(request: CreateUserMediaRequest): Promise<UserMediaEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserMediaEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserMediaEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserMediaEntity>>;
  fetchById(id: EntityId): Promise<UserMediaEntity>;
  update(id: EntityId, request: UpdateUserMediaRequest): Promise<UserMediaEntity>;
  deleteById(id: EntityId): Promise<UserMediaEntity>;
}
export const IUserMediaService = Symbol('IUserMediaService');
