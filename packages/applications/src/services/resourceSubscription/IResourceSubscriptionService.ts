import { EntityId, ResourceSubscriptionEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../common';
import { CreateResourceSubscriptionRequest, UpdateResourceSubscriptionRequest } from './dto';

export interface IResourceSubscriptionService {
  create(request: CreateResourceSubscriptionRequest): Promise<ResourceSubscriptionEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<ResourceSubscriptionEntity>>;
  fetchAllByResource(props: PaginatedQuery & { resourceTypeName: string; resourceId: string }): Promise<FetchResponse<ResourceSubscriptionEntity>>;
  fetchByResource(resourceTypeName: string, resourceId: EntityId): Promise<ResourceSubscriptionEntity | null>;
  fetchById(id: EntityId): Promise<ResourceSubscriptionEntity>;
  update(id: EntityId, request: UpdateResourceSubscriptionRequest): Promise<ResourceSubscriptionEntity>;
  toggleSubscriptionByResource(resourceTypeName: string, resourceId: EntityId): Promise<ResourceSubscriptionEntity>;
  toggleSubscriptionById(id: EntityId): Promise<ResourceSubscriptionEntity>;
  deleteById(id: EntityId): Promise<ResourceSubscriptionEntity>;
}
export const IResourceSubscriptionService = Symbol('IResourceSubscriptionService');
