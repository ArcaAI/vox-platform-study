import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { IAuditLogService } from './IAuditLogService';
import { AuditLogRepository, AuditLogEntityMapper, CoreDatabaseService } from '@arcaai/domains';
import { EventTypes, AuditAction, AuditLogEntity, ResourceType, AuditLogFactory, SysEventType } from '@arcaai/domains';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedPaginatedProps, withFormattedCountProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { SUPER_ADMIN_ROLE } from '../tenant/constants';

/**
 * Service for managing audit logs.
 *
 * ## Audit Log Creation Architecture
 *
 * There are two distinct paths for creating audit log entries:
 *
 * ### Path 1: System Events → Redis Queue (CRUD operations)
 * Services call `broadcastSysEvent(SysEventType.*)` which emits events like
 * `'SysEvent.ResourceCreated'`. These are handled by `SysEventService`, which
 * queues `AuditLogJob` to Redis for async processing by a background worker.
 * This is the PRIMARY path for all CRUD audit logs.
 *
 * ### Path 2: Domain Events → Direct Write (Authentication)
 * `AuthService` emits `EventTypes.UserAuthenticated` (`'user.authenticated'`)
 * which is handled directly by this service's `handleUserAuthenticatedEvent()`.
 * This creates audit logs synchronously within the request lifecycle.
 *
 * ### Important Design Note
 * The `EventTypes` enum values (e.g., `'resource.created'`) differ from
 * `SysEventType` values (e.g., `'SysEvent.ResourceCreated'`). CRUD audit logs
 * are handled exclusively via the SysEventService → Redis queue path.
 */
@Injectable()
export class AuditLogService extends BaseService implements IAuditLogService {
  private readonly logger: Logger = new Logger(AuditLogService.name);

  /**
   * Constructor for AuditLogService.
   * @param auditLogRepository - Repository for accessing audit logs.
   * @param eventEmitter - Event emitter for broadcasting events.
   * @param clsService - Service for managing context-local storage.
   */
  constructor(
    private readonly auditLogRepository: AuditLogRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // TASK-314 §7 — the authentication-audit write must bypass the tenant-scope
    // `$extends` via the unscoped `baseClient` (see handleUserAuthenticatedEvent).
    // Same sanctioned escape hatch UserRoleAssignmentService uses for the
    // pre-auth identity reads.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
  ) {
    super(eventEmitter, clsService, ResourceType.AuditLog);
  }

  /**
   * Fetch all audit logs with pagination and search capabilities.
   * Uses Promise.all to parallelize data fetch and count queries for better performance.
   *
   * TASK-305 D.8 (HIPAA §164.312(b)): scoped to the caller's CLS tenantId so
   * a Tenant-A admin can never enumerate Tenant-B audit rows. SUPER_ADMIN
   * bypasses the filter (cross-tenant audit access).
   *
   * @param props - Pagination and search properties.
   * @returns A promise that resolves to a FetchResponse containing audit logs.
   */
  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<AuditLogEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;

    const tenantScopedFindWhere = this.buildTenantWhere();
    const tenantScopedCountWhere = this.buildTenantWhere();

    // Parallelize data fetch and count queries for better performance
    const [auditLogs, count] = await Promise.all([
      this.auditLogRepository.findAll({
        ...withFormattedPaginatedProps(props),
        where: tenantScopedFindWhere,
      }),
      this.auditLogRepository.count({
        ...withFormattedCountProps(props),
        where: tenantScopedCountWhere,
      }),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: auditLogs.map((auditLog: AuditLogEntity) => auditLog.id),
      },
    });
    return new FetchResponse<AuditLogEntity>({
      data: auditLogs,
      count,
      limit,
      page,
    });
  }

  /**
   * Fetch all audit logs related to a specific resource.
   * Uses Promise.all to parallelize data fetch and count queries for better performance.
   *
   * TASK-305 D.8: caller's tenantId is merged into the resource-scoped
   * where clause; SUPER_ADMIN bypasses.
   *
   * @param props - Pagination, resource type, and resource ID.
   * @returns A promise that resolves to a FetchResponse containing audit logs.
   */
  async fetchAllByResource(props: PaginatedQuery & { resourceType: string; resourceId: string }): Promise<FetchResponse<AuditLogEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { resourceType, resourceId, limit, page, search } = props;

    const whereClause = this.buildTenantWhere({
      resourceId,
      resourceType: resourceType as ResourceType,
    });

    // Parallelize data fetch and count queries for better performance
    const [auditLogs, count] = await Promise.all([
      this.auditLogRepository.findAll({
        ...withFormattedPaginatedProps(props),
        where: whereClause,
      }),
      this.auditLogRepository.count({
        ...withFormattedCountProps(props),
        where: whereClause,
      }),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        resourceId,
        resourceType,
        items: auditLogs.map((auditLog: AuditLogEntity) => auditLog.id),
      },
    });
    return new FetchResponse<AuditLogEntity>({
      data: auditLogs,
      count,
      limit,
      page,
    });
  }

  /**
   * Fetch all audit logs created by a specific user.
   * Uses Promise.all to parallelize data fetch and count queries for better performance.
   *
   * TASK-305 D.8: caller's tenantId is merged into the user-scoped where
   * clause; SUPER_ADMIN bypasses.
   *
   * @param props - Pagination and user ID.
   * @returns A promise that resolves to a FetchResponse containing audit logs.
   */
  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<AuditLogEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;

    const whereClause = this.buildTenantWhere({
      responsibleUserId: userId,
    });

    // Parallelize data fetch and count queries for better performance
    const [auditLogs, count] = await Promise.all([
      this.auditLogRepository.findAll({
        ...withFormattedPaginatedProps(props),
        where: whereClause,
      }),
      this.auditLogRepository.count({
        ...withFormattedCountProps(props),
        where: whereClause,
      }),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: auditLogs.map((auditLog: AuditLogEntity) => auditLog.id),
      },
    });
    return new FetchResponse<AuditLogEntity>({
      data: auditLogs,
      count,
      limit,
      page,
    });
  }

  /**
   * Fetch a specific audit log by its ID.
   *
   * TASK-305 D.8: after loading the entity we assert it belongs to the
   * caller's tenant — if not, throw `NotFoundException` (mirrors the
   * DepartmentService pattern; never leak existence with 403).
   *
   * @param id - The ID of the audit log to fetch.
   * @returns A promise that resolves to the fetched AuditLogEntity.
   */
  public async fetchById(id: string): Promise<AuditLogEntity> {
    const auditLog = await this.auditLogRepository.findById(id);
    this.assertTenantOwnership(auditLog, id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: auditLog.id,
      data: auditLog.toObject() as object,
    });
    return auditLog;
  }

  /**
   * Delete a specific audit log by its ID.
   *
   * TASK-305 D.8: load-then-assert-then-delete so we never soft-delete an
   * audit row belonging to another tenant. `NotFoundException` is thrown
   * for cross-tenant ids to avoid existence leakage.
   *
   * @param id - The ID of the audit log to delete.
   * @returns A promise that resolves to the deleted AuditLogEntity.
   */
  public async deleteById(id: string): Promise<AuditLogEntity> {
    const existing = await this.auditLogRepository.findById(id);
    this.assertTenantOwnership(existing, id);

    const auditLog = await this.auditLogRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: auditLog.id,
      data: auditLog.toObject() as object,
    });
    return auditLog;
  }

  /**
   * True when the active request user carries the SUPER_ADMIN role.
   * Falls back to `false` whenever CLS is missing or the role list is
   * undefined — strictest default, mirrors `TenantService.isSuperAdmin`.
   */
  private isSuperAdmin(): boolean {
    const roles = this.requestUser?.roles;
    return Array.isArray(roles) && roles.includes(SUPER_ADMIN_ROLE);
  }

  /**
   * Build a Prisma `where` clause that always scopes to the caller's CLS
   * tenantId, unless the caller is SUPER_ADMIN.
   *
   * Throws `NotFoundException` when a non-super-admin caller has no
   * tenantId in CLS, so the query never widens to all tenants by
   * accident (Prisma treats `tenantId: undefined` as "no filter").
   */
  private buildTenantWhere<T extends object>(extra?: T): T & { tenantId?: string } {
    const base = extra ?? ({} as T);
    if (this.isSuperAdmin()) {
      return { ...base } as T & { tenantId?: string };
    }
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new NotFoundException('AuditLog scope unavailable');
    }
    return { ...base, tenantId } as T & { tenantId?: string };
  }

  /**
   * Assert the loaded entity belongs to the caller's tenant. SUPER_ADMIN
   * bypasses. Throws `NotFoundException` (not `ForbiddenException`) so
   * the API never reveals that a record exists for another tenant.
   */
  private assertTenantOwnership(auditLog: AuditLogEntity, id: string): void {
    if (this.isSuperAdmin()) return;
    if (auditLog.tenantId !== this.tenantId) {
      throw new NotFoundException(`AuditLog ${id} not found`);
    }
  }

  /**
   * Handle the event when a user is authenticated.
   * Creates an audit log entry with LOGIN action type for security tracking.
   *
   * This is triggered by AuthService emitting EventTypes.UserAuthenticated
   * ('user.authenticated'). Unlike CRUD events (which flow through
   * SysEventService → Redis queue), authentication events are handled
   * directly here for immediate audit trail creation.
   *
   * @param event - The authentication event containing user data.
   */
  @OnEvent(EventTypes.UserAuthenticated)
  async handleUserAuthenticatedEvent(
    event: {
      userId?: string;
      timestamp?: Date;
      ip?: string;
      userAgent?: string;
      method?: string;
      endpoint?: string;
      impersonatedUserId?: string;
    } & Record<string, unknown>,
  ): Promise<void> {
    try {
      const userId = event.userId || (event as { id?: string }).id || null;
      const timestamp = event.timestamp || new Date();
      const impersonatedUserId = event.impersonatedUserId;
      const isImpersonatedRequest = Boolean(impersonatedUserId);

      // TASK-295 C-3: persist actor + subject + endpoint distinctly for
      // impersonated per-request audit rows so HIPAA actor-on-subject
      // traceability is queryable. Non-impersonated path (login/logout)
      // continues to use the existing LOGIN row shape.
      const auditLog = AuditLogFactory.CreateAuditLog({
        action: isImpersonatedRequest ? AuditAction.IMPERSONATED_ACTION : AuditAction.LOGIN,
        eventType: isImpersonatedRequest ? 'IMPERSONATION' : 'AUTHENTICATION',
        success: true,
        responsibleUserId: userId,
        responsibleIp: event.ip || this.requestIp,
        resourceId: isImpersonatedRequest ? impersonatedUserId! : userId,
        resourceType: ResourceType.User,
        data: isImpersonatedRequest
          ? {
              endpoint: event.endpoint ?? null,
              httpMethod: event.method ?? null,
              impersonatedUserId,
              timestamp: timestamp.toISOString(),
              userAgent: event.userAgent || null,
            }
          : {
              method: event.method || 'oauth',
              timestamp: timestamp.toISOString(),
              userAgent: event.userAgent || null,
            },
        previousData: {},
        metadata: null,
        createdBy: null,
        // TASK-305 A.8 follow-up: factory requires tenantId. CLS tenantId is normally set by auth
        // middleware before this @OnEvent handler fires; for the rare LOGIN-edge case where CLS
        // isn't established yet (true pre-auth path), fall back to the system tenant — LOGIN/
        // IMPERSONATION audits are platform-level events per the cursor rule.
        tenantId: this.tenantId ?? '00000000-0000-0000-0000-000000000000',
      });

      // TASK-314 §7 — baseClient (tenant-scope bypass). `trackAuthentication`
      // emits `user.authenticated` while CLS still has NO tenant context (login
      // is a public route, so this @OnEvent handler runs in the unauthenticated
      // request scope). `AuditLog` is tenant-scoped (TASK-305 Phase B), so the
      // scoped repository write throws "tenant context required for model
      // AuditLog" and the LOGIN/IMPERSONATION row is silently dropped by the
      // catch below. The row's tenantId is already resolved above (CLS tenant,
      // or SYSTEM_TENANT_ID for tenant-less/system logins), so the scope filter
      // adds nothing here — the unscoped create is the sanctioned path, mirroring
      // the pre-auth identity reads in UserRoleAssignmentService (TASK-314).
      const persistence = AuditLogEntityMapper.getInstance().toPersistence(auditLog) as unknown as Record<string, unknown>;
      // Drop null scalars so Prisma's JSON columns (`data`/`metadata`) accept the
      // payload, matching Repository.create's `removeNullValues` behaviour.
      const data = Object.fromEntries(Object.entries(persistence).filter(([, value]) => value !== null));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.databaseService.baseClient.auditLog.create({ data: data as any });

      this.logger.debug({
        message: isImpersonatedRequest
          ? 'Impersonated request audit log created'
          : 'User authenticated audit log created',
        userId,
        impersonatedUserId: impersonatedUserId ?? null,
        endpoint: event.endpoint ?? null,
        method: event.method || 'oauth',
      });
    } catch (error: unknown) {
      this.logger.error({
        message: 'Error handling user authenticated event',
        eventType: EventTypes.UserAuthenticated,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}
