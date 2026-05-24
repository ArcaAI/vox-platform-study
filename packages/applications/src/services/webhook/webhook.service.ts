import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ResourceType, SysEventType, EntityId, WebhookEntity, WebhookFactory, WebhookRepository } from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { IWebhookService } from './IWebhookService';
import { CreateWebhookRequest, UpdateWebhookRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';

// TODO: Implement this

@Injectable()
export class WebhookService extends BaseService implements IWebhookService {
  constructor(
    private readonly webhookRepository: WebhookRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Webhook);
  }

  async create(request: CreateWebhookRequest): Promise<WebhookEntity> {
    const newWebhook = WebhookFactory.CreateWebhook({
      ...request,
      tenantId: request.tenantId,
      createdBy: this.requestUser?.id,
    });

    const webhook = await this.webhookRepository.create(newWebhook);

    if (!webhook) {
      throw new InternalServerErrorException(`Failed to create WebhookEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: webhook.id,
      createdAt: webhook.createdAt,
      data: webhook.toObject() as object,
    });
    return webhook;
  }

  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<WebhookEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
    const webhooks = await this.webhookRepository.findAll(withFormattedPaginatedProps(props));

    const count = await this.webhookRepository.count(withFormattedCountProps(props));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: webhooks.map((webhook: WebhookEntity) => webhook.id),
      },
    });
    return new FetchResponse<WebhookEntity>({
      data: webhooks,
      count,
      limit,
      page,
    });
  }

  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<WebhookEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { tenantId, limit, page, search } = props;
    const webhooks = await this.webhookRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        tenantId,
      },
    });
    const count = await this.webhookRepository.count({
      ...withFormattedCountProps(props),
      where: {
        tenantId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        tenantId,
        items: webhooks.map((webhook: WebhookEntity) => webhook.id),
      },
    });
    return new FetchResponse<WebhookEntity>({
      data: webhooks,
      count,
      limit,
      page,
    });
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<WebhookEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;
    const webhooks = await this.webhookRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.webhookRepository.count({
      ...withFormattedCountProps(props),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: webhooks.map((webhook: WebhookEntity) => webhook.id),
      },
    });
    return new FetchResponse<WebhookEntity>({
      data: webhooks,
      count,
      limit,
      page,
    });
  }

  async fetchById(id: EntityId): Promise<WebhookEntity> {
    const webhook = await this.webhookRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: webhook.id,
      data: webhook.toObject() as object,
    });
    return webhook;
  }

  /**
   * Update a webhook.
   *
   * TASK-302 Stream D Phase E.5 — OCC migration. Writes via Compare-And-Set
   * against the row's `_version` column. The DTO's `expectedVersion` (or
   * the controller's `If-Match`-folded value, once a controller is
   * wired) is the CAS predicate; on version drift the repository raises
   * `OptimisticConcurrencyException`, which the `ExceptionInterceptor`
   * maps to `412 Precondition Failed`.
   */
  async update(id: EntityId, request: UpdateWebhookRequest): Promise<WebhookEntity> {
    const webhook = await this.webhookRepository.findById(id);

    const previousData = webhook.toObject();
    const { expectedVersion, ...editableRequest } = request;
    this.updateEntity(webhook, editableRequest as UpdateWebhookRequest);

    if (!webhook.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }

    // Snapshot the pre-write `_version` BEFORE the CAS bumps it (audit
    // correlation mirrors C.8 / E.1 / E.2 / E.3 / E.4).
    const previousVersion = webhook.version;

    const updatedWebhook = await this.webhookRepository.updateWithVersion(id, webhook, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedWebhook.id,
      data: { ...webhook.changes, previousVersion, newVersion: updatedWebhook.version },
      previousData,
    });
    return updatedWebhook;
  }

  async deleteById(id: EntityId): Promise<WebhookEntity> {
    const webhook = await this.webhookRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: webhook.id,
      data: webhook.toObject() as object,
    });
    return webhook;
  }
}
