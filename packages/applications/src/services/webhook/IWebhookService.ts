import { EntityId, WebhookEntity, WebhookRunHistoryEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../common';
import { IBaseService } from '../../interfaces';
import { CreateWebhookRequest, UpdateWebhookRequest } from './dto';

/**
 * Result of a webhook write that mints a new signing secret
 * (`create`/`rotateSecret`). Mirrors `CreateApiKeyResult`: the raw secret is
 * returned exactly once and is NEVER persisted or retrievable again — only
 * `webhook.hashedSecret` (the peppered hash) is stored.
 */
export interface CreateWebhookResult {
  webhook: WebhookEntity;
  rawSecret: string;
}

export interface IWebhookService extends IBaseService {
  create(request: CreateWebhookRequest): Promise<CreateWebhookResult>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<WebhookEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<WebhookEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<WebhookEntity>>;
  fetchById(id: EntityId): Promise<WebhookEntity>;
  update(id: EntityId, request: UpdateWebhookRequest): Promise<WebhookEntity>;
  deleteById(id: EntityId): Promise<WebhookEntity>;
  /** Webhook-scoped delivery log (tenancy via the parent webhook). */
  fetchRunHistory(webhookId: EntityId, props: PaginatedQuery): Promise<FetchResponse<WebhookRunHistoryEntity>>;
  /** Mint a fresh signing secret for an existing webhook (OCC — see controller `@RequiresIfMatch`). */
  rotateSecret(id: EntityId, expectedVersion: number): Promise<CreateWebhookResult>;
}
export const IWebhookService = Symbol('IWebhookService');
