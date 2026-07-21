import { EntityId, NotificationEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../common';
import { IBaseService } from '../../interfaces';
import { CreateNotificationRequest, UpdateNotificationRequest } from './dto';

export interface INotificationService extends IBaseService {
  create(request: CreateNotificationRequest): Promise<NotificationEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<NotificationEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<NotificationEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<NotificationEntity>>;
  fetchById(id: EntityId): Promise<NotificationEntity>;
  update(id: EntityId, request: UpdateNotificationRequest): Promise<NotificationEntity>;
  deleteById(id: EntityId): Promise<NotificationEntity>;
}
export const INotificationService = Symbol('INotificationService');
