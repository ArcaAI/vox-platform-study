import { EntityId, WebhookEntity, WebhookRunHistoryEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../common';
import { IBaseService } from '../../interfaces';
import { CreateWebhookRequest, UpdateWebhookRequest } from './dto';

export interface IWebhookService extends IBaseService {
  create(request: CreateWebhookRequest): Promise<WebhookEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<WebhookEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<WebhookEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<WebhookEntity>>;
  fetchById(id: EntityId): Promise<WebhookEntity>;
  update(id: EntityId, request: UpdateWebhookRequest): Promise<WebhookEntity>;
  deleteById(id: EntityId): Promise<WebhookEntity>;
  /** TASK-419 item 2 — webhook-scoped delivery log (tenancy via the parent webhook). */
  fetchRunHistory(webhookId: EntityId, props: PaginatedQuery): Promise<FetchResponse<WebhookRunHistoryEntity>>;
}
export const IWebhookService = Symbol('IWebhookService');
