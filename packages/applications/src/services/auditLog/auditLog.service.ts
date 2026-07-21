import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  IAuditLogService,
  AuditLogFilters,
  FilteredAuditLogResult,
  CursorFilteredAuditLogResult,
  AuditLogExportResult,
  ResponsibleUserMap,
} from './IAuditLogService';
import { ResponsibleUserResponse } from './dto';
import { AuditLogRepository, AuditLogEntityMapper, CoreDatabaseService, UserRepository, UserEntity } from '@arcaai/domains';
import { EventTypes, AuditAction, AuditLogEntity, ResourceType, AuditLogFactory } from '@arcaai/domains';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  BaseService,
  FetchResponse,
  PaginatedQuery,
  CursorQuery,
  withFormattedPaginatedProps,
  withFormattedCountProps,
  deserializeFilterString,
  buildCursorFindAllProps,
  toCursorPage,
  clampCursorLimit,
  decodeCursor,
} from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { GLOBAL_ADMIN_ROLE } from '../tenant/constants';
import { AuditLogEncryptionService } from './auditLog-encryption.service';

/**
 * Hard cap on rows materialised for a single CSV export so a
 * wide (or unfiltered) range can never stream an unbounded result set into
 * memory. Tune alongside the UI page sizes if exports start truncating.
 */
const AUDIT_LOG_EXPORT_MAX = 10000;

/**
 * The audit-log resource's Prisma model name. Passed to
 * `withFormatted{Paginated,Count}Props` so the shared deserializer coerces the
 * stringly-typed CSV `filters` values of `AuditLog`'s boolean/number/date
 * columns to their real types before the `where` reaches Prisma (e.g.
 * `success` → boolean, `version` → number, `createdAt` → Date). String/enum
 * columns (resourceType, action, eventType, …) stay strings. This is purely
 * additive to the structured `from`/`to`/`action`/`resourceType`/`userId`
 * filters built by `buildAuditFilterWhere`.
 */
const AUDIT_LOG_FILTER_MODEL = 'AuditLog';

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
    // The authentication-audit write must bypass the tenant-scope
    // `$extends` via the unscoped `baseClient` (see handleUserAuthenticatedEvent).
    // Same sanctioned escape hatch UserRoleAssignmentService uses for the
    // pre-auth identity reads.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // Resolves responsibleUserId → display name/email for the
    // admin table. User is a global model (no tenantId column) so a tenant
    // admin can safely label rows authored by cross-tenant/system actors.
    private readonly userRepository: UserRepository,
    // Envelope encryption for data/previousData on the two
    // direct-write paths below, and decrypt-on-read for fetchById. @Optional so
    // direct-construction unit tests keep working (plaintext-only soak).
    @Optional() private readonly auditLogEncryption?: AuditLogEncryptionService,
  ) {
    super(eventEmitter, clsService, ResourceType.AuditLog);
  }

  /**
   * Fetch all audit logs with pagination and search capabilities.
   * Uses Promise.all to parallelize data fetch and count queries for better performance.
   *
   * (HIPAA §164.312(b)): scoped to the caller's CLS tenantId so
   * a Tenant-A admin can never enumerate Tenant-B audit rows. GLOBAL_ADMIN
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
        ...withFormattedPaginatedProps(props, AUDIT_LOG_FILTER_MODEL),
        where: tenantScopedFindWhere,
      }),
      this.auditLogRepository.count({
        ...withFormattedCountProps(props, AUDIT_LOG_FILTER_MODEL),
        where: tenantScopedCountWhere,
      }),
    ]);

    // OB-04: reads of the audit log are never themselves audited.
    return new FetchResponse<AuditLogEntity>({
      data: auditLogs,
      count,
      limit,
      page,
    });
  }

  /**
   * Paginated, filtered audit-log list with acting-user
   * enrichment.
   *
   * The `from`/`to`/`action`/`resourceType`/`userId` filters are translated to
   * a Prisma `where` fragment and merged with the tenant scope, so filtering
   * happens IN THE DATABASE (never in-memory). After the page loads we resolve
   * each distinct `responsibleUserId` to a display label in a single batch
   * query — avoiding an N+1 per row.
   */
  async fetchAllFiltered(props: PaginatedQuery & AuditLogFilters): Promise<FilteredAuditLogResult> {
    const { limit, page } = props;

    const whereClause = this.buildTenantWhere(this.buildAuditFilterWhere(props));

    const [auditLogs, count] = await Promise.all([
      this.auditLogRepository.findAll({
        ...withFormattedPaginatedProps(props, AUDIT_LOG_FILTER_MODEL),
        where: whereClause,
      }),
      this.auditLogRepository.count({
        ...withFormattedCountProps(props, AUDIT_LOG_FILTER_MODEL),
        where: whereClause,
      }),
    ]);

    const responsibleUsers = await this.resolveResponsibleUsers(auditLogs.map((log) => log.responsibleUserId));

    // OB-04: reads of the audit log are never themselves audited.
    return {
      result: new FetchResponse<AuditLogEntity>({ data: auditLogs, count, limit, page }),
      responsibleUsers,
    };
  }

  /**
   * Cursor (keyset) page of the filtered, tenant-scoped audit list.
   *
   * The opt-in counterpart of {@link fetchAllFiltered}: it reuses the SAME
   * `buildTenantWhere(buildAuditFilterWhere(...))` scope+filter builder (so
   * tenant isolation, GLOBAL_ADMIN bypass, and the A8 filters behave
   * identically), then orders by the stable `(createdAt, id)` DESC keyset and
   * over-fetches `limit + 1` rows to derive `hasMore`/`nextCursor`. A single
   * batch resolves the page's acting users (no N+1) — mirroring the offset path.
   *
   * No `count` is issued: keyset pagination is intentionally count-free (that's
   * the scalability win for high-volume lists).
   */
  async fetchPageByCursor(props: CursorQuery & AuditLogFilters): Promise<CursorFilteredAuditLogResult> {
    const cursor = props.cursor ? decodeCursor(props.cursor) : null;
    if (props.cursor && !cursor) {
      throw new BadRequestException('Invalid cursor');
    }

    const limit = clampCursorLimit(props.limit);
    const whereClause = this.buildTenantWhere(this.buildAuditFilterWhere(props));

    // Apply the SAME model-aware CSV `filters` coercion
    // as the offset path (fetchAllFiltered): the stringly-typed `field[op]:value`
    // values (e.g. `success`→bool, `version`→number, `createdAt`→Date,
    // `action`→enum) are coerced against the 'AuditLog' model. It is passed as
    // the `filters` prop — SEPARATE from the keyset/tenant `where` — so
    // Repository.findAll's `formatFindAllProps` AND-composes it with the keyset
    // predicate, exactly as the offset path threads withFormattedPaginatedProps.
    const filters = props.filters ? deserializeFilterString(props.filters, AUDIT_LOG_FILTER_MODEL) : undefined;

    const rows = await this.auditLogRepository.findAll({
      ...buildCursorFindAllProps(cursor, limit, { where: whereClause }),
      filters,
    });

    const page = toCursorPage(rows, limit, (row) => this.toCursorKey(row.createdAt));
    const responsibleUsers = await this.resolveResponsibleUsers(page.data.map((log) => log.responsibleUserId));

    // OB-04: reads of the audit log are never themselves audited.
    return { page, responsibleUsers };
  }

  /**
   * Normalise a `createdAt` value into the cursor's sort-key string. Stored as
   * an ISO-8601 timestamp so the opaque cursor stays stable and deterministic.
   */
  private toCursorKey(createdAt: Date | string): string {
    return createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
  }

  /**
   * Materialise the ENTIRE filtered, tenant-scoped result set
   * (capped at {@link AUDIT_LOG_EXPORT_MAX}) for CSV export. Reuses the same
   * `where` builder + tenant scope as {@link fetchAllFiltered} so an export
   * always matches what the operator sees in the table, ordered newest-first.
   */
  async exportFiltered(filters: AuditLogFilters): Promise<AuditLogExportResult> {
    const whereClause = this.buildTenantWhere(this.buildAuditFilterWhere(filters));

    const rows = await this.auditLogRepository.findAll({
      where: whereClause,
      page: 1,
      limit: AUDIT_LOG_EXPORT_MAX,
      sort: [{ createdAt: 'desc' }],
    });

    const responsibleUsers = await this.resolveResponsibleUsers(rows.map((row) => row.responsibleUserId));

    // OB-04: exporting the audit log is itself a read of the audit
    // log and is never audited (no self-inflation of the trail).
    return { rows, responsibleUsers };
  }

  /**
   * Translate the optional audit filters into a Prisma `where` fragment.
   * Only fields that are actually present are emitted, so an empty filter
   * set degrades to "match everything (within tenant scope)".
   *
   * `from`/`to` map to an inclusive `createdAt` `gte`/`lte` range; the UI is
   * responsible for sending start-of-day / end-of-day boundaries.
   */
  private buildAuditFilterWhere(filters: AuditLogFilters): {
    createdAt?: { gte?: Date; lte?: Date };
    action?: AuditAction;
    resourceType?: ResourceType;
    responsibleUserId?: string;
  } {
    const where: {
      createdAt?: { gte?: Date; lte?: Date };
      action?: AuditAction;
      resourceType?: ResourceType;
      responsibleUserId?: string;
    } = {};

    const createdAt: { gte?: Date; lte?: Date } = {};
    if (filters.from) createdAt.gte = new Date(filters.from);
    if (filters.to) createdAt.lte = new Date(filters.to);
    if (createdAt.gte || createdAt.lte) where.createdAt = createdAt;

    if (filters.action) where.action = filters.action;
    if (filters.resourceType) where.resourceType = filters.resourceType;
    if (filters.userId) where.responsibleUserId = filters.userId;

    return where;
  }

  /**
   * Resolve a set of (possibly null/duplicated) `responsibleUserId`s to a
   * `id → label` map in ONE query. Display name prefers the user's profile
   * name, then username; email comes from the profile when present.
   */
  private async resolveResponsibleUsers(userIds: Array<string | null | undefined>): Promise<ResponsibleUserMap> {
    const ids = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
    if (ids.length === 0) return {};

    const users = await this.userRepository.findAll({
      where: { id: { in: ids } },
      page: 1,
      limit: ids.length,
    });

    const map: ResponsibleUserMap = {};
    for (const user of users) {
      map[user.id] = new ResponsibleUserResponse({
        id: user.id,
        displayName: this.resolveDisplayName(user),
        email: user.UserProfile?.email ?? null,
      });
    }
    return map;
  }

  /**
   * Best-effort human label for an acting user: "First Last" from the
   * profile, falling back to username, then null.
   */
  private resolveDisplayName(user: UserEntity): string | null {
    const profile = user.UserProfile;
    const fullName = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ').trim();
    return fullName || user.username || null;
  }

  /**
   * Fetch all audit logs related to a specific resource.
   * Uses Promise.all to parallelize data fetch and count queries for better performance.
   *
   * Caller's tenantId is merged into the resource-scoped
   * where clause; GLOBAL_ADMIN bypasses.
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
        ...withFormattedPaginatedProps(props, AUDIT_LOG_FILTER_MODEL),
        where: whereClause,
      }),
      this.auditLogRepository.count({
        ...withFormattedCountProps(props, AUDIT_LOG_FILTER_MODEL),
        where: whereClause,
      }),
    ]);

    // OB-04: reads of the audit log are never themselves audited.
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
   * Caller's tenantId is merged into the user-scoped where
   * clause; GLOBAL_ADMIN bypasses.
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
        ...withFormattedPaginatedProps(props, AUDIT_LOG_FILTER_MODEL),
        where: whereClause,
      }),
      this.auditLogRepository.count({
        ...withFormattedCountProps(props, AUDIT_LOG_FILTER_MODEL),
        where: whereClause,
      }),
    ]);

    // OB-04: reads of the audit log are never themselves audited.
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
   * After loading the entity we assert it belongs to the
   * caller's tenant — if not, throw `NotFoundException` (mirrors the
   * DepartmentService pattern; never leak existence with 403).
   *
   * @param id - The ID of the audit log to fetch.
   * @returns A promise that resolves to the fetched AuditLogEntity.
   */
  public async fetchById(id: string): Promise<AuditLogEntity> {
    const auditLog = await this.auditLogRepository.findById(id);
    this.assertTenantOwnership(auditLog, id);

    // Single-record reads decrypt the envelope payloads in
    // place (with plaintext fallback for legacy rows). Best-effort: never throws.
    // Only fetchById decrypts — the list/export paths stay on the retained
    // plaintext columns to avoid per-row crypto on hot read paths during soak.
    await this.auditLogEncryption?.decryptIntoEntity(auditLog);

    // OB-04: reading a single audit row is never itself audited.
    return auditLog;
  }

  // OB-10 — the soft-delete capability was intentionally removed for
  // audit-log immutability (HIPAA §164.312(b)/(c)(1)). Audit rows are append-only
  // from the admin surface; any retention/archival must be an explicit, separately
  // audited process — never an ad-hoc admin delete.

  /**
   * True when the active request user carries the GLOBAL_ADMIN role.
   * Falls back to `false` whenever CLS is missing or the role list is
   * undefined — strictest default, mirrors `TenantService.isSuperAdmin`.
   */
  private isSuperAdmin(): boolean {
    const roles = this.requestUser?.roles;
    return Array.isArray(roles) && roles.includes(GLOBAL_ADMIN_ROLE);
  }

  /**
   * Build a Prisma `where` clause that always scopes to the caller's CLS
   * tenantId, unless the caller is GLOBAL_ADMIN.
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
   * Assert the loaded entity belongs to the caller's tenant. GLOBAL_ADMIN
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
      // Impersonation lifecycle discriminator. Present on the
      // explicit start/stop bracket rows emitted by AuthController; absent on
      // the per-request IMPERSONATED_ACTION rows from the audit interceptor.
      phase?: 'START' | 'STOP';
      // Lifecycle bracket enrichment (super-admin impersonation
      // endpoint): operator justification, token expiry, resolved tenant.
      reason?: string;
      expiresAt?: string;
      impersonationTenantId?: string;
    } & Record<string, unknown>,
  ): Promise<void> {
    try {
      const userId = event.userId || (event as { id?: string }).id || null;
      const timestamp = event.timestamp || new Date();
      const impersonatedUserId = event.impersonatedUserId;
      const isImpersonatedRequest = Boolean(impersonatedUserId);

      // Persist actor + subject + endpoint distinctly for
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
              // START/STOP for the explicit lifecycle bracket;
              // null for ordinary per-request impersonated actions.
              phase: event.phase ?? null,
              // Bracket enrichment; only present on rows emitted by
              // the super-admin impersonation endpoint (undefined elsewhere,
              // and undefined JSON keys are dropped on serialization).
              ...(event.reason ? { reason: event.reason } : {}),
              ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
              ...(event.impersonationTenantId ? { impersonationTenantId: event.impersonationTenantId } : {}),
            }
          : {
              method: event.method || 'oauth',
              timestamp: timestamp.toISOString(),
              userAgent: event.userAgent || null,
            },
        previousData: {},
        metadata: null,
        createdBy: null,
        // Factory requires tenantId. CLS tenantId is normally set by auth
        // middleware before this @OnEvent handler fires; for the rare LOGIN-edge case where CLS
        // isn't established yet (true pre-auth path), fall back to the system tenant — LOGIN/
        // IMPERSONATION audits are platform-level events per the cursor rule.
        tenantId: this.tenantId ?? '00000000-0000-0000-0000-000000000000',
      });

      // Envelope-encrypt before mapping so the persisted row
      // carries ciphertext (+ plaintext, dual-read soak). Best-effort; no-op when
      // the encryption service is absent or Vault is unavailable.
      await this.auditLogEncryption?.encryptIntoEntity(auditLog);

      // BaseClient (tenant-scope bypass). `trackAuthentication`
      // emits `user.authenticated` while CLS still has NO tenant context (login
      // is a public route, so this @OnEvent handler runs in the unauthenticated
      // request scope). `AuditLog` is tenant-scoped, so the
      // scoped repository write throws "tenant context required for model
      // AuditLog" and the LOGIN/IMPERSONATION row is silently dropped by the
      // catch below. The row's tenantId is already resolved above (CLS tenant,
      // or SYSTEM_TENANT_ID for tenant-less/system logins), so the scope filter
      // adds nothing here — the unscoped create is the sanctioned path, mirroring
      // the pre-auth identity reads in UserRoleAssignmentService.
      const persistence = AuditLogEntityMapper.getInstance().toPersistence(auditLog) as unknown as Record<string, unknown>;
      // Drop null scalars so Prisma's JSON columns (`data`/`metadata`) accept the
      // payload, matching Repository.create's `removeNullValues` behaviour.
      const data = Object.fromEntries(Object.entries(persistence).filter(([, value]) => value !== null));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.databaseService.baseClient.auditLog.create({ data: data as any });

      this.logger.debug({
        message: isImpersonatedRequest ? 'Impersonated request audit log created' : 'User authenticated audit log created',
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

  /**
   * Persist a FAILED authentication attempt.
   *
   * Counterpart to `handleUserAuthenticatedEvent`, which is a success-only
   * bracket. Without this, a rejected login left only a structured warn log,
   * so credential stuffing and post-termination access attempts were not
   * reviewable in the audit table — the gap HIPAA §164.312(b) access auditing
   * is meant to close.
   *
   * Shares the success handler's sanctioned direct-write path: a failed login
   * runs in the unauthenticated request scope (no CLS tenant), so the scoped
   * repository would reject the tenant-scoped `AuditLog` write. Row-shape
   * differences from the success path: `success: false`, plus `reason` and
   * `attemptedUsername` (the only identity signal when the username matched
   * no account).
   *
   * Only whitelisted fields reach the persisted payload — an upstream caller
   * widening the event must not be able to spill a credential into the row.
   *
   * Best-effort by contract: every error is caught, because failing here would
   * convert a 401 into a 500 and hand attackers an audit-outage oracle.
   */
  @OnEvent(EventTypes.UserAuthenticationFailed)
  async handleUserAuthenticationFailedEvent(event: {
    userId?: string;
    attemptedUsername?: string;
    reason?: string;
    timestamp?: Date;
    ip?: string;
    userAgent?: string;
    method?: string;
    endpoint?: string;
    tenantKey?: string;
  }): Promise<void> {
    try {
      const timestamp = event.timestamp || new Date();

      const auditLog = AuditLogFactory.CreateAuditLog({
        action: AuditAction.LOGIN,
        eventType: 'AUTHENTICATION',
        success: false,
        responsibleUserId: event.userId ?? null,
        responsibleIp: event.ip || this.requestIp,
        // A failed attempt often has no resolved account; the row still points
        // at the User resource so it lands in the same review surface.
        resourceId: event.userId ?? null,
        resourceType: ResourceType.User,
        data: {
          reason: event.reason ?? 'unspecified',
          attemptedUsername: event.attemptedUsername ?? null,
          endpoint: event.endpoint ?? null,
          httpMethod: event.method ?? null,
          tenantKey: event.tenantKey ?? null,
          timestamp: timestamp.toISOString(),
          userAgent: event.userAgent || null,
        },
        previousData: {},
        metadata: null,
        createdBy: null,
        tenantId: this.tenantId ?? '00000000-0000-0000-0000-000000000000',
      });

      await this.auditLogEncryption?.encryptIntoEntity(auditLog);

      const persistence = AuditLogEntityMapper.getInstance().toPersistence(auditLog) as unknown as Record<string, unknown>;
      const data = Object.fromEntries(Object.entries(persistence).filter(([, value]) => value !== null));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- null-stripped persistence record no longer matches Prisma's generated create input; same cast as the success handler
      await this.databaseService.baseClient.auditLog.create({ data: data as any });

      this.logger.debug({
        message: 'Failed authentication audit log created',
        userId: event.userId ?? null,
        reason: event.reason ?? 'unspecified',
        endpoint: event.endpoint ?? null,
      });
    } catch (error: unknown) {
      this.logger.error({
        message: 'Error handling failed authentication event',
        eventType: EventTypes.UserAuthenticationFailed,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Record a privileged/system action audit entry synchronously.
   *
   * Mirrors `handleUserAuthenticatedEvent`'s sanctioned direct-write path: the
   * row is built via the factory and persisted through the UNSCOPED `baseClient`
   * (so a tenant-less super-admin operator's row is still written — `AuditLog`
   * is tenant-scoped, and the scoped client would reject a null/foreign tenant).
   *
   * Best-effort by contract: all errors are caught and logged so the privileged
   * caller (e.g. the Prisma Studio BFF) is never blocked by an audit failure.
   */
  public async recordSystemAction(params: {
    action: AuditAction;
    eventType: string;
    resourceType: ResourceType;
    resourceId?: string | null;
    data?: Record<string, unknown>;
    success?: boolean;
  }): Promise<void> {
    try {
      const auditLog = AuditLogFactory.CreateAuditLog({
        action: params.action,
        eventType: params.eventType,
        success: params.success ?? true,
        responsibleUserId: this.requestUser?.id ?? null,
        responsibleIp: this.requestIp,
        resourceId: params.resourceId ?? null,
        resourceType: params.resourceType,
        // The factory's `data` is a Prisma JsonValue; the public param keeps the
        // ergonomic Record<string, unknown> shape, so narrow it here.
        data: (params.data ?? {}) as unknown as AuditLogEntity['data'],
        previousData: {},
        metadata: null,
        createdBy: this.requestUser?.id ?? null,
        tenantId: this.tenantId ?? '00000000-0000-0000-0000-000000000000',
      });

      // Envelope-encrypt data/previousData before mapping
      // (best-effort; plaintext retained for the dual-read soak).
      await this.auditLogEncryption?.encryptIntoEntity(auditLog);

      const persistence = AuditLogEntityMapper.getInstance().toPersistence(auditLog) as unknown as Record<string, unknown>;
      const data = Object.fromEntries(Object.entries(persistence).filter(([, value]) => value !== null));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.databaseService.baseClient.auditLog.create({ data: data as any });
    } catch (error: unknown) {
      this.logger.error({
        message: 'Error recording system action audit',
        eventType: params.eventType,
        action: params.action,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
