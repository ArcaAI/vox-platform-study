import { EntityId, AuditLogEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../common';

/**
 * Interface for the Audit Log Service, defining the methods for managing audit logs.
 *
 * ## Audit Log Creation Architecture
 *
 * CRUD audit logs (CREATE, READ, UPDATE, DELETE) are created exclusively via
 * the SysEventService → Redis queue → background worker path. This service
 * handles only:
 * - Querying/fetching audit logs
 * - Deleting audit logs
 * - Direct event handling for authentication events (UserAuthenticated)
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
     * Fetch all audit logs related to a specific resource.
     * @param props - The pagination properties along with resource type and resource ID.
     * @returns A promise that resolves to a FetchResponse containing the audit logs for the specified resource.
     */
    fetchAllByResource(
        props: PaginatedQuery & { resourceType: string; resourceId: string },
    ): Promise<FetchResponse<AuditLogEntity>>;

    /**
     * Fetch all audit logs created by a specific user.
     * @param props - The pagination properties along with the user ID.
     * @returns A promise that resolves to a FetchResponse containing the audit logs created by the specified user.
     */
    fetchAllCreatedByUser(
        props: PaginatedQuery & { userId: string },
    ): Promise<FetchResponse<AuditLogEntity>>;

    /**
     * Fetch a specific audit log by its ID.
     * @param id - The ID of the audit log to fetch.
     * @returns A promise that resolves to the requested AuditLogEntity.
     */
    fetchById(id: EntityId): Promise<AuditLogEntity>;

    /**
     * Delete a specific audit log by its ID.
     * @param id - The ID of the audit log to delete.
     * @returns A promise that resolves to the deleted AuditLogEntity.
     */
    deleteById(id: EntityId): Promise<AuditLogEntity>;

    /**
     * Handle the event of a user being authenticated.
     * Creates an audit log entry with LOGIN action for security tracking.
     * Triggered by AuthService emitting EventTypes.UserAuthenticated.
     * @param event - The authentication event containing user data.
     * @returns A promise that resolves when the audit log is created.
     */
    handleUserAuthenticatedEvent(event: { userId?: string; timestamp?: Date; ip?: string; userAgent?: string; method?: string } & Record<string, unknown>): Promise<void>;
}

/**
 * Symbol for the IAuditLogService interface, used for dependency injection.
 */
export const IAuditLogService = Symbol('IAuditLogService');
