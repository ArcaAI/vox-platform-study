import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
  UserRoleAssignmentRepository,
} from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { INotificationService } from './INotificationService';
import { CreateNotificationRequest, UpdateNotificationRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../common';
import { assertParentInScope, assertUserBelongsToTenant } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { SUPER_ADMIN_ROLE } from '../tenant/constants';

@Injectable()
export class NotificationService extends BaseService implements INotificationService {
  constructor(
    private readonly notificationRepository: NotificationRepository,
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    private readonly resourceSubscriptionRepository: ResourceSubscriptionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Notification);
  }

  /**
   * TASK-305 D.5.1 (audit C-5, B10) — close the notification cross-tenant
   * gap. Two leaks are possible without service-layer guards:
   *   1. Routing a notification to a `targetUserId` who has no role in the
   *      caller's tenant (User has no `tenantId` FK in the schema).
   *   2. Anchoring it to a `resourceSubscriptionId` belonging to another
   *      tenant.
   *
   * The flow is:
   *   - Pin the working `tenantId` to CLS unless the caller is SUPER_ADMIN
   *     and explicitly overrides via `request.tenantId` (mirrors the D.7
   *     UserRoleAssignment pattern).
   *   - Assert `targetUserId` membership in the effective tenant. SUPER_ADMIN
   *     does NOT bypass — sending notifications to users in other tenants is
   *     a data-leak vector (notifications carry PHI hints).
   *   - When `resourceSubscriptionId` is supplied, assert the subscription
   *     row belongs to the effective tenant.
   */
  async create(request: CreateNotificationRequest): Promise<NotificationEntity> {
    const effectiveTenantId = this.resolveEffectiveTenantId(request.tenantId);

    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, request.targetUserId, effectiveTenantId);

    if (request.resourceSubscriptionId) {
      await assertParentInScope(this.resourceSubscriptionRepository, request.resourceSubscriptionId, effectiveTenantId);
    }

    const newNotification = NotificationFactory.CreateNotification({
      ...request,
      tenantId: effectiveTenantId,
      createdBy: this.requestUser?.id,
    });

    const notification = await this.notificationRepository.create(newNotification);

    if (!notification) {
      throw new InternalServerErrorException(`Failed to create NotificationEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: notification.id,
      createdAt: notification.createdAt,
      data: notification.toObject() as object,
    });
    return notification;
  }

  /**
   * TASK-305 D.5.1 — list endpoint scoped to the caller's tenant. Mirrors the
   * `AuditLogService.fetchAll` D.8 pattern: SUPER_ADMIN bypasses the filter,
   * everyone else is pinned to CLS `tenantId`.
   */
  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<NotificationEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
    const tenantScopedWhere = this.buildTenantWhere();

    const [notifications, count] = await Promise.all([
      this.notificationRepository.findAll({
        ...withFormattedPaginatedProps(props),
        where: tenantScopedWhere,
      }),
      this.notificationRepository.count({
        ...withFormattedCountProps(props),
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
   * TASK-306 P1.5 (audit AC-7 / NEW-3) — refuse cross-tenant list reads
   * driven by the DTO `tenantId`. Pre-guard, any caller could enumerate
   * another tenant's notifications by supplying a foreign `tenantId`.
   * SUPER_ADMIN bypasses for admin-tooling cross-tenant listing.
   */
  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<NotificationEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { tenantId, limit, page, search } = props;

    if (tenantId !== this.tenantId && !this.isSuperAdmin()) {
      throw new NotFoundException('Resource not found');
    }

    const notifications = await this.notificationRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        tenantId,
      },
    });
    const count = await this.notificationRepository.count({
      ...withFormattedCountProps(props),
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
   * TASK-305 D.5.1 — `createdBy` filter is merged with the caller's CLS
   * `tenantId` so a Tenant-A admin querying by an arbitrary user-id can
   * never enumerate notifications created by that user in Tenant-B.
   */
  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<NotificationEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;
    const tenantScopedWhere = this.buildTenantWhere({ createdBy: userId });

    const [notifications, count] = await Promise.all([
      this.notificationRepository.findAll({
        ...withFormattedPaginatedProps(props),
        where: tenantScopedWhere,
      }),
      this.notificationRepository.count({
        ...withFormattedCountProps(props),
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
   * TASK-305 D.5.1 — load-then-assert. Throw `NotFoundException` (never
   * `Forbidden`) on a cross-tenant id to avoid existence leakage.
   */
  async fetchById(id: EntityId): Promise<NotificationEntity> {
    const notification = await this.notificationRepository.findById(id);
    this.assertTenantOwnership(notification, id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: notification.id,
      data: notification.toObject() as object,
    });
    return notification;
  }

  async update(id: EntityId, request: UpdateNotificationRequest): Promise<NotificationEntity> {
    const notification = await this.notificationRepository.findById(id);
    this.assertTenantOwnership(notification, id);

    const previousData = notification.toObject();
    this.updateEntity(notification, request);

    if (!notification.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedNotification = await this.notificationRepository.update(id, notification);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedNotification.id,
      data: notification.changes,
      previousData,
    });
    return updatedNotification;
  }

  async deleteById(id: EntityId): Promise<NotificationEntity> {
    const existing = await this.notificationRepository.findById(id);
    this.assertTenantOwnership(existing, id);

    const notification = await this.notificationRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: notification.id,
      data: notification.toObject() as object,
    });
    return notification;
  }

  /**
   * Resolve the tenantId to use for a write. The DTO's `tenantId` is allowed
   * only when (a) it equals CLS `tenantId` (already-pinned UI flow) or (b)
   * the caller is `SUPER_ADMIN` (cross-tenant administrative dispatch). A
   * non-SUPER_ADMIN explicit mismatch is a privilege-escalation attempt and
   * is rejected with `ForbiddenException`. Missing CLS context for a
   * non-SUPER_ADMIN caller fails closed via the helper-side `BadRequestException`.
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
   * True when the active request user carries the SUPER_ADMIN role. Mirrors
   * the strict-default behaviour in `TenantService.isSuperAdmin()` and
   * `AuditLogService` — falls back to `false` whenever the role list is
   * missing, so the most restrictive policy applies.
   */
  private isSuperAdmin(): boolean {
    const roles = this.requestUser?.roles;
    return Array.isArray(roles) && roles.includes(SUPER_ADMIN_ROLE);
  }

  /**
   * Build a Prisma `where` clause that always scopes to the caller's CLS
   * tenantId, unless the caller is SUPER_ADMIN. Throws `NotFoundException`
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
   * Assert the loaded entity belongs to the caller's tenant. SUPER_ADMIN
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
