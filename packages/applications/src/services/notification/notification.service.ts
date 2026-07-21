import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ResourceType,
  SysEventType,
  EntityId,
  NotificationEntity,
  NotificationFactory,
  NotificationRepository,
  ResourceSubscriptionRepository,
  UserDepartmentRepository,
  UserRepository,
  UserRoleAssignmentRepository,
} from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { INotificationService } from './INotificationService';
import { CreateNotificationRequest, UpdateNotificationRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps, encryptPhiFields } from '../../common';
import { assertParentInScope, assertUserBelongsToTenant } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { GLOBAL_ADMIN_ROLE } from '../tenant/constants';

/**
 * Ciphertext columns that must never cross an audit /
 * SysEvent boundary. The entity serializer (`toObject()` / `changes`) iterates
 * every backing field, so the encrypted message blobs + shared key version are
 * stripped from any payload derived from the entity.
 */
const NOTIFICATION_CIPHERTEXT_KEYS = ['encryptedMessageText', 'encryptedMessageRichText', 'encryptedMessageContent', 'keyVersion'] as const;

/**
 * Model-aware filter coercion:
 * `read` → boolean, `version`/`keyVersion` → number, `createdAt` → Date,
 * `type`/`resourceStatus` → member-validated enums, `metaData` → JSON-path
 * support. The encrypted Bytes columns are not filterable.
 */
const NOTIFICATION_FILTER_MODEL = 'Notification';

@Injectable()
export class NotificationService extends BaseService implements INotificationService {
  constructor(
    private readonly notificationRepository: NotificationRepository,
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    // Membership is role + department; the guard needs the
    // department join table and the User table (service-account exemption).
    private readonly userDepartmentRepository: UserDepartmentRepository,
    private readonly userRepository: UserRepository,
    private readonly resourceSubscriptionRepository: ResourceSubscriptionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Vault-Transit field encryption for the notification
    // message body (messageText / messageRichText / messageContent). Optional +
    // @Inject so legacy/direct-construction tests still work; when absent these
    // PHI fields are left unpersisted (the plaintext columns were dropped).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.Notification);
  }

  private readonly logger = new Logger(NotificationService.name);

  /**
   * Encrypt the notification's plaintext message fields (messageText /
   * messageRichText / messageContent) into their `encrypted*` / `keyVersion`
   * columns through the shared env-gated guard: a soft no-op in dev/test,
   * FAIL-CLOSED (throws) in staging/prod (SECRETS_PROVIDER=vault).
   */
  private async encryptMessage(entity: NotificationEntity): Promise<void> {
    await encryptPhiFields(
      this.secretsService,
      'Notification message',
      () => this.notificationRepository.encryptFieldsIntoEntity(entity, this.secretsService!),
      this.logger,
    );
  }

  /**
   * Drop the ciphertext columns from an entity-derived audit
   * payload (`toObject()` / `changes` / `previousData`) so the SysEvent never
   * carries the raw ciphertext Buffer or the key version.
   */
  private stripCiphertext(payload: object): Record<string, unknown> {
    const clone = { ...(payload as Record<string, unknown>) };
    for (const key of NOTIFICATION_CIPHERTEXT_KEYS) {
      delete clone[key];
    }
    return clone;
  }

  /**
   * Close the notification cross-tenant
   * gap. Two leaks are possible without service-layer guards:
   *   1. Routing a notification to a `targetUserId` who has no role in the
   *      caller's tenant (User has no `tenantId` FK in the schema).
   *   2. Anchoring it to a `resourceSubscriptionId` belonging to another
   *      tenant.
   *
   * The flow is:
   *   - Pin the working `tenantId` to CLS unless the caller is GLOBAL_ADMIN
   *     and explicitly overrides via `request.tenantId` (mirrors the
   *     UserRoleAssignment pattern).
   *   - Assert `targetUserId` membership in the effective tenant. GLOBAL_ADMIN
   *     does NOT bypass — sending notifications to users in other tenants is
   *     a data-leak vector (notifications carry PHI hints).
   *   - When `resourceSubscriptionId` is supplied, assert the subscription
   *     row belongs to the effective tenant.
   */
  async create(request: CreateNotificationRequest): Promise<NotificationEntity> {
    const effectiveTenantId = this.resolveEffectiveTenantId(request.tenantId);

    await assertUserBelongsToTenant(
      this.userRoleAssignmentRepository,
      this.userDepartmentRepository,
      this.userRepository,
      request.targetUserId,
      effectiveTenantId,
    );

    if (request.resourceSubscriptionId) {
      await assertParentInScope(this.resourceSubscriptionRepository, request.resourceSubscriptionId, effectiveTenantId);
    }

    const newNotification = NotificationFactory.CreateNotification({
      ...request,
      tenantId: effectiveTenantId,
      createdBy: this.requestUser?.id,
    });

    // Encrypt the message body into the ciphertext columns
    // before the first persist (dual-write; plaintext is retained for the soak).
    await this.encryptMessage(newNotification);

    const notification = await this.notificationRepository.create(newNotification);

    if (!notification) {
      throw new InternalServerErrorException(`Failed to create NotificationEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: notification.id,
      createdAt: notification.createdAt,
      data: this.stripCiphertext(notification.toObject()),
    });
    return notification;
  }

  /**
   * List endpoint scoped to the caller's tenant. Mirrors the
   * `AuditLogService.fetchAll` D.8 pattern: GLOBAL_ADMIN bypasses the filter,
   * everyone else is pinned to CLS `tenantId`.
   */
  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<NotificationEntity>> {
    const { limit, page } = props;
    const tenantScopedWhere = this.buildTenantWhere();

    const [notifications, count] = await Promise.all([
      this.notificationRepository.findAll({
        ...withFormattedPaginatedProps(props, NOTIFICATION_FILTER_MODEL),
        where: tenantScopedWhere,
      }),
      this.notificationRepository.count({
        ...withFormattedCountProps(props, NOTIFICATION_FILTER_MODEL),
        where: tenantScopedWhere,
      }),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: notifications.map((notification: NotificationEntity) => notification.id),
      },
    });
    return new FetchResponse<NotificationEntity>({
      data: notifications,
      count,
      limit,
      page,
    });
  }

  /**
   * Refuse cross-tenant list reads driven by the DTO `tenantId` — without this
   * guard any caller could enumerate another tenant's notifications by
   * supplying a foreign `tenantId`. GLOBAL_ADMIN bypasses for admin-tooling
   * cross-tenant listing.
   */
  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<NotificationEntity>> {
    const { tenantId, limit, page } = props;

    if (tenantId !== this.tenantId && !this.isSuperAdmin()) {
      throw new NotFoundException('Resource not found');
    }

    const notifications = await this.notificationRepository.findAll({
      ...withFormattedPaginatedProps(props, NOTIFICATION_FILTER_MODEL),
      where: {
        tenantId,
      },
    });
    const count = await this.notificationRepository.count({
      ...withFormattedCountProps(props, NOTIFICATION_FILTER_MODEL),
      where: {
        tenantId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        tenantId,
        items: notifications.map((notification: NotificationEntity) => notification.id),
      },
    });
    return new FetchResponse<NotificationEntity>({
      data: notifications,
      count,
      limit,
      page,
    });
  }

  /**
   * `createdBy` filter is merged with the caller's CLS
   * `tenantId` so a Tenant-A admin querying by an arbitrary user-id can
   * never enumerate notifications created by that user in Tenant-B.
   */
  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<NotificationEntity>> {
    const { userId, limit, page } = props;
    const tenantScopedWhere = this.buildTenantWhere({ createdBy: userId });

    const [notifications, count] = await Promise.all([
      this.notificationRepository.findAll({
        ...withFormattedPaginatedProps(props, NOTIFICATION_FILTER_MODEL),
        where: tenantScopedWhere,
      }),
      this.notificationRepository.count({
        ...withFormattedCountProps(props, NOTIFICATION_FILTER_MODEL),
        where: tenantScopedWhere,
      }),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: notifications.map((notification: NotificationEntity) => notification.id),
      },
    });
    return new FetchResponse<NotificationEntity>({
      data: notifications,
      count,
      limit,
      page,
    });
  }

  /**
   * Load-then-assert. Throw `NotFoundException` (never
   * `Forbidden`) on a cross-tenant id to avoid existence leakage.
   */
  async fetchById(id: EntityId): Promise<NotificationEntity> {
    const notification = await this.notificationRepository.findById(id);
    this.assertTenantOwnership(notification, id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: notification.id,
      data: this.stripCiphertext(notification.toObject()),
    });
    return notification;
  }

  async update(id: EntityId, request: UpdateNotificationRequest): Promise<NotificationEntity> {
    const notification = await this.notificationRepository.findById(id);
    this.assertTenantOwnership(notification, id);

    const previousData = notification.toObject();
    this.updateEntity(notification, request);

    // Re-encrypt only when a message field actually changed
    // (read by the entity change-set, not the request DTO, since the API DTO
    // field names differ from the entity columns) so read-status / tag-only
    // updates don't churn the ciphertext columns.
    const changedKeys = notification.changes as Record<string, unknown>;
    const messageChanged =
      'messageText' in changedKeys || 'messageRichText' in changedKeys || 'messageContent' in changedKeys;
    if (messageChanged) {
      await this.encryptMessage(notification);
    }

    if (!notification.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedNotification = await this.notificationRepository.update(id, notification);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedNotification.id,
      data: this.stripCiphertext(notification.changes),
      previousData: this.stripCiphertext(previousData),
    });
    return updatedNotification;
  }

  async deleteById(id: EntityId): Promise<NotificationEntity> {
    const existing = await this.notificationRepository.findById(id);
    this.assertTenantOwnership(existing, id);

    const notification = await this.notificationRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: notification.id,
      data: this.stripCiphertext(notification.toObject()),
    });
    return notification;
  }

  /**
   * Resolve the tenantId to use for a write. The DTO's `tenantId` is allowed
   * only when (a) it equals CLS `tenantId` (already-pinned UI flow) or (b)
   * the caller is `GLOBAL_ADMIN` (cross-tenant administrative dispatch). A
   * non-GLOBAL_ADMIN explicit mismatch is a privilege-escalation attempt and
   * is rejected with `ForbiddenException`. Missing CLS context for a
   * non-GLOBAL_ADMIN caller fails closed via the helper-side `BadRequestException`.
   */
  private resolveEffectiveTenantId(requestedTenantId?: string | null): string {
    const callerTenantId = this.tenantId ?? null;
    const isExplicitCrossTenant = requestedTenantId !== undefined && requestedTenantId !== null && requestedTenantId !== callerTenantId;

    if (isExplicitCrossTenant) {
      if (!this.isSuperAdmin()) {
        throw new ForbiddenException('Cross-tenant notification dispatch is not permitted');
      }
      return requestedTenantId;
    }

    if (!callerTenantId) {
      // Spec D.5.1: fail closed when no CLS tenant context is available.
      throw new BadRequestException('Tenant context is required');
    }
    return callerTenantId;
  }

  /**
   * True when the active request user carries the GLOBAL_ADMIN role. Mirrors
   * the strict-default behaviour in `TenantService.isSuperAdmin()` and
   * `AuditLogService` — falls back to `false` whenever the role list is
   * missing, so the most restrictive policy applies.
   */
  private isSuperAdmin(): boolean {
    const roles = this.requestUser?.roles;
    return Array.isArray(roles) && roles.includes(GLOBAL_ADMIN_ROLE);
  }

  /**
   * Build a Prisma `where` clause that always scopes to the caller's CLS
   * tenantId, unless the caller is GLOBAL_ADMIN. Throws `NotFoundException`
   * when a non-super-admin caller has no tenantId in CLS so the query never
   * widens to all tenants by accident (Prisma treats `tenantId: undefined`
   * as "no filter"). Mirrors `AuditLogService.buildTenantWhere`.
   */
  private buildTenantWhere<T extends object>(extra?: T): T & { tenantId?: string } {
    const base = extra ?? ({} as T);
    if (this.isSuperAdmin()) {
      return { ...base } as T & { tenantId?: string };
    }
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new NotFoundException('Notification scope unavailable');
    }
    return { ...base, tenantId } as T & { tenantId?: string };
  }

  /**
   * Assert the loaded entity belongs to the caller's tenant. GLOBAL_ADMIN
   * bypasses. Throws `NotFoundException` (not `ForbiddenException`) so the
   * API never reveals that a record exists for another tenant.
   */
  private assertTenantOwnership(notification: NotificationEntity, id: string): void {
    if (this.isSuperAdmin()) return;
    if (notification.tenantId !== this.tenantId) {
      throw new NotFoundException(`Notification ${id} not found`);
    }
  }
}
