import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ResourceType, SysEventType, EntityId, WebhookEntity, WebhookFactory, WebhookRepository } from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { IWebhookService } from './IWebhookService';
import { CreateWebhookRequest, UpdateWebhookRequest } from './dto';
import { assertEqualTenants, BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { SUPER_ADMIN_ROLE } from '../tenant/constants';

@Injectable()
export class WebhookService extends BaseService implements IWebhookService {
  constructor(
    private readonly webhookRepository: WebhookRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Webhook);
  }

  /**
   * TASK-306 P1.4 (audit M-2 / NEW-2 / AC-5 partial) — non-SUPER_ADMIN
   * callers can no longer attribute a webhook to another tenant via the
   * DTO. Effective tenant is resolved through `resolveEffectiveTenantId`,
   * which silently pins to CLS for regular users and honors
   * `request.tenantId` only for SUPER_ADMIN (cross-tenant impersonation
   * flows, e.g. admin UI / migration tooling).
   */
  async create(request: CreateWebhookRequest): Promise<WebhookEntity> {
    const effectiveTenantId = this.resolveEffectiveTenantId(request.tenantId);
    const newWebhook = WebhookFactory.CreateWebhook({
      ...request,
      tenantId: effectiveTenantId,
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

  /**
   * TASK-306 P2.3 (audit M-2 / AC-5) — list endpoint scoped to the
   * caller's tenant. Non-SUPER_ADMIN callers see only their own tenant's
   * webhooks; SUPER_ADMIN bypasses the filter so cross-tenant
   * administration tooling can list every webhook in the platform.
   * Mirrors the W3.2 NotificationService.fetchAll posture.
   */
  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<WebhookEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
    const baseWhere = this.isSuperAdmin() ? {} : { tenantId: this.tenantId };
    const paginatedProps = withFormattedPaginatedProps(props);
    const countProps = withFormattedCountProps(props);
    const webhooks = await this.webhookRepository.findAll({
      ...paginatedProps,
      where: { ...paginatedProps.where, ...baseWhere },
    });

    const count = await this.webhookRepository.count({
      ...countProps,
      where: { ...countProps.where, ...baseWhere },
    });

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

  /**
   * TASK-306 P2.3 (audit M-2 / AC-5 + AC-7) — refuse cross-tenant list
   * reads driven by the DTO `tenantId`. Pre-guard, any caller could
   * enumerate another tenant's webhooks by supplying a foreign
   * `tenantId`. SUPER_ADMIN bypasses for admin-tooling cross-tenant
   * listing (mirrors the W5.1.5 Notification + ApiKey
   * `fetchAllByTenantId` posture).
   */
  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<WebhookEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { tenantId, limit, page, search } = props;

    if (tenantId !== this.tenantId && !this.isSuperAdmin()) {
      throw new NotFoundException('Resource not found');
    }

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

  /**
   * TASK-306 P2.3 (audit M-2 / AC-5) — load-then-assert. Throw
   * `NotFoundException` (never `ForbiddenException`) on a cross-tenant
   * id so the API does not reveal that the row exists in another
   * tenant. SUPER_ADMIN bypasses for admin tooling.
   */
  async fetchById(id: EntityId): Promise<WebhookEntity> {
    const webhook = await this.webhookRepository.findById(id);
    if (!this.isSuperAdmin()) {
      assertEqualTenants(webhook, { tenantId: this.tenantId });
    }

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
    // TASK-306 P2.3 (audit M-2 / AC-5) — load-then-assert defense-in-depth.
    // Throws NotFoundException on cross-tenant id BEFORE the CAS write
    // fires, so a foreign webhook is never mutated. SUPER_ADMIN bypasses
    // for admin tooling.
    if (!this.isSuperAdmin()) {
      assertEqualTenants(webhook, { tenantId: this.tenantId });
    }

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

  /**
   * TASK-306 P2.3 (audit M-2 / AC-5) — load-then-assert before the
   * soft-delete write. Pre-guard, `softDelete(id)` ran directly with no
   * tenant check, so a Tenant-A user with knowledge of a foreign id
   * could delete another tenant's webhook. The new pre-load+assert
   * surfaces NotFoundException on cross-tenant ids so the foreign row
   * is never marked deleted. SUPER_ADMIN bypasses the pre-load (saves
   * a round-trip for admin tooling that legitimately deletes across
   * tenants).
   */
  async deleteById(id: EntityId): Promise<WebhookEntity> {
    if (!this.isSuperAdmin()) {
      const existing = await this.webhookRepository.findById(id);
      assertEqualTenants(existing, { tenantId: this.tenantId });
    }

    const webhook = await this.webhookRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: webhook.id,
      data: webhook.toObject() as object,
    });
    return webhook;
  }

  /**
   * Resolve the tenantId to use for a write. Non-SUPER_ADMIN callers are
   * silently pinned to CLS; SUPER_ADMIN may override via `request.tenantId`
   * for cross-tenant impersonation. Throws `BadRequestException` if no
   * tenant context resolves (caller has no CLS AND no DTO `tenantId`
   * after the super-admin branch).
   *
   * Differs from `NotificationService.resolveEffectiveTenantId` only in
   * that a non-super-admin mismatch is silently coerced instead of
   * throwing `ForbiddenException`; webhooks are less sensitive than PHI
   * notification dispatch and the README W5.1.4 verification contract
   * mandates "row created with tenant-A" on silent coercion.
   */
  private resolveEffectiveTenantId(requestTenantId?: string): string {
    if (this.isSuperAdmin() && requestTenantId) return requestTenantId;
    const cls = this.tenantId;
    if (!cls) throw new BadRequestException('Tenant context required');
    return cls;
  }

  /**
   * True when the active request user carries the SUPER_ADMIN role.
   * Mirrors the strict-default helper used by `TenantService` and
   * `AuthorizationAuditService` — falls back to `false` whenever the role
   * list is missing so the most restrictive policy applies.
   */
  private isSuperAdmin(): boolean {
    const roles = this.requestUser?.roles;
    return Array.isArray(roles) && roles.includes(SUPER_ADMIN_ROLE);
  }
}
