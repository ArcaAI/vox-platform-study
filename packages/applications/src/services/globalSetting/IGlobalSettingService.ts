import { EntityId, GlobalSettingEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../common';
import { IBaseService } from '../../interfaces';
import { CreateGlobalSettingRequest, UpdateGlobalSettingRequest } from './dto';

// TODO: Implement this

export interface IGlobalSettingService extends IBaseService {
  create(request: CreateGlobalSettingRequest): Promise<GlobalSettingEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<GlobalSettingEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<GlobalSettingEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<GlobalSettingEntity>>;
  fetchById(id: EntityId): Promise<GlobalSettingEntity>;
  update(id: EntityId, request: UpdateGlobalSettingRequest): Promise<GlobalSettingEntity>;
  deleteById(id: EntityId): Promise<GlobalSettingEntity>;
}
export const IGlobalSettingService = Symbol('IGlobalSettingService');
