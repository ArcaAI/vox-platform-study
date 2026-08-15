import { EntityId, AuditLogEntity, AuditAction, ResourceType } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery, CursorQuery, CursorPage } from '../../common';
import { ResponsibleUserResponse } from './dto';

/**
 * Repository-pushed audit filters. Every field is optional;
 * the service translates present fields into a Prisma `where` fragment
 * (date range → `createdAt` gte/lte; the rest → equality).
 */
export interface AuditLogFilters {
  from?: string | null;
  to?: string | null;
  action?: AuditAction | null;
  resourceType?: ResourceType | null;
  userId?: string | null;
}

/**
 * Map of `responsibleUserId` → resolved acting-user label. Built once per
 * page so the controller can enrich each row without an N+1 lookup.
 */
export type ResponsibleUserMap = Record<string, ResponsibleUserResponse>;

/** A filtered page plus its resolved acting users. */
export interface FilteredAuditLogResult {
  result: FetchResponse<AuditLogEntity>;
  responsibleUsers: ResponsibleUserMap;
}

/** A cursor (keyset) page plus its resolved acting users. */
export interface CursorFilteredAuditLogResult {
  page: CursorPage<AuditLogEntity>;
  responsibleUsers: ResponsibleUserMap;
}

/** The full filtered set (no pagination) for CSV export. */
export interface AuditLogExportResult {
  rows: AuditLogEntity[];
  responsibleUsers: ResponsibleUserMap;
}

/**
 * Interface for the Audit Log Service, defining the methods for managing audit logs.
 *
 * ## Audit Log Creation Architecture
 *
 * CRUD audit logs (CREATE, READ, UPDATE, DELETE) are created exclusively via
 * the SysEventService → Redis queue → background worker path. This service
 * handles only:
 * - Querying/fetching audit logs
 * - Direct event handling for authentication events (UserAuthenticated)
 *
 * Audit logs are append-only: there is intentionally no delete capability
 * so the trail stays immutable for compliance.
 *
 * @see SysEventService for the CRUD event → Redis queue pipeline
 */
export interface IAuditLogService {
  /**
   * Fetch all audit logs with pagination.
   * @param props - The pagination and filtering properties.
   * @returns A promise that resolves to a FetchResponse containing the audit logs.
   */
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<AuditLogEntity>>;

  /**
   * Fetch a paginated, filtered page of audit logs and resolve
   * the acting user for each row. Filters (`from`/`to`/`action`/`resourceType`/
   * `userId`) are pushed to the repository `where` clause; tenant scoping is
   * applied exactly like {@link fetchAll} (CLS tenant, SUPER_ADMIN bypass).
   *
   * @param props - Pagination + audit filters.
   * @returns The page plus a `responsibleUserId` → label map.
   */
  fetchAllFiltered(props: PaginatedQuery & AuditLogFilters): Promise<FilteredAuditLogResult>;

  /**
   * Fetch a cursor (keyset) page of audit logs and resolve the
   * acting user for each row. The opt-in cursor counterpart of
   * {@link fetchAllFiltered}: same filters + tenant scoping (CLS tenant,
   * SUPER_ADMIN bypass), but ordered by the stable `(createdAt, id)` DESC
   * keyset and paginated by an opaque cursor instead of page/limit.
   *
   * @param props - Cursor (`cursor`/`limit`) + audit filters.
   * @returns The keyset page (`data`/`nextCursor`/`hasMore`) plus a
   *   `responsibleUserId` → label map.
   * @throws BadRequestException when `cursor` is present but malformed.
   */
  fetchPageByCursor(props: CursorQuery & AuditLogFilters): Promise<CursorFilteredAuditLogResult>;

  /**
   * Load the ENTIRE filtered, tenant-scoped result set (capped)
   * for CSV export. Same `where`/tenant semantics as
   * {@link fetchAllFiltered}, but without page windowing.
   *
   * @param filters - Audit filters (no pagination).
   * @returns Every matching row plus a `responsibleUserId` → label map.
   */
  exportFiltered(filters: AuditLogFilters): Promise<AuditLogExportResult>;

  /**
   * Fetch all audit logs related to a specific resource.
   * @param props - The pagination properties along with resource type and resource ID.
   * @returns A promise that resolves to a FetchResponse containing the audit logs for the specified resource.
   */
  fetchAllByResource(props: PaginatedQuery & { resourceType: string; resourceId: string }): Promise<FetchResponse<AuditLogEntity>>;

  /**
   * Fetch all audit logs created by a specific user.
   * @param props - The pagination properties along with the user ID.
   * @returns A promise that resolves to a FetchResponse containing the audit logs created by the specified user.
   */
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<AuditLogEntity>>;

  /**
   * Fetch a specific audit log by its ID.
   * @param id - The ID of the audit log to fetch.
   * @returns A promise that resolves to the requested AuditLogEntity.
   */
  fetchById(id: EntityId): Promise<AuditLogEntity>;

  /**
   * Handle the event of a user being authenticated.
   * Creates an audit log entry with LOGIN action for security tracking.
   * Triggered by AuthService emitting EventTypes.UserAuthenticated.
   * @param event - The authentication event containing user data.
   * @returns A promise that resolves when the audit log is created.
   */
  handleUserAuthenticatedEvent(
    event: { userId?: string; timestamp?: Date; ip?: string; userAgent?: string; method?: string } & Record<string, unknown>,
  ): Promise<void>;

  /**
   * Handle a FAILED authentication attempt.
   *
   * Counterpart to `handleUserAuthenticatedEvent` (which is success-only).
   * Writes a LOGIN row with `success: false` so rejected access is reviewable
   * alongside granted access, per HIPAA §164.312(b). Triggered by
   * `EventTypes.UserAuthenticationFailed`.
   *
   * `userId` is absent when the attempt matched no account — `attemptedUsername`
   * is then the only identity signal. Best-effort: never throws.
   *
   * @param event - The failed-authentication event.
   * @returns A promise that resolves when the audit log write has been attempted.
   */
  handleUserAuthenticationFailedEvent(event: {
    userId?: string;
    attemptedUsername?: string;
    reason?: string;
    timestamp?: Date;
    ip?: string;
    userAgent?: string;
    method?: string;
    endpoint?: string;
    tenantKey?: string;
  }): Promise<void>;

  /**
   * Synchronously record a privileged/system action audit entry
   * via the direct-write path (bypassing the SysEvent → Redis queue pipeline).
   *
   * Intended for privileged surfaces that are NOT BaseService CRUD flows — e.g.
   * the Prisma Studio raw-SQL BFF, which connects to the database outside the
   * tenant-scope extension and therefore emits no `broadcastSysEvent`. The
   * caller's actor/tenant are taken from CLS; tenant falls back to the system
   * tenant for tenant-less operators (super-admin).
   *
   * Best-effort: never throws — failures are logged so an audit-write error can
   * never block the privileged operation it is recording.
   */
  recordSystemAction(params: {
    action: AuditAction;
    eventType: string;
    resourceType: ResourceType;
    resourceId?: string | null;
    data?: Record<string, unknown>;
    success?: boolean;
  }): Promise<void>;
}

/**
 * Symbol for the IAuditLogService interface, used for dependency injection.
 */
export const IAuditLogService = Symbol('IAuditLogService');
