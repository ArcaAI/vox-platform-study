import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { IAuditLogService } from './IAuditLogService';
import { AuditLogRepository } from '@arcaai/domains';
import {
    EventTypes,
    AuditAction,
    AuditLogEntity,
    ResourceType,
    AuditLogFactory,
    SysEventType
} from '@arcaai/domains';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    BaseService,
    FetchResponse,
    PaginatedQuery,
    withFormattedPaginatedProps,
    withFormattedCountProps
} from '../../common';
import { IActiveUserContext } from '../../interfaces';

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
        protected override readonly clsService: ClsService<IActiveUserContext>
    ) {
        super(eventEmitter, clsService, ResourceType.AuditLog);
    }

    /**
     * Fetch all audit logs with pagination and search capabilities.
     * Uses Promise.all to parallelize data fetch and count queries for better performance.
     * @param props - Pagination and search properties.
     * @returns A promise that resolves to a FetchResponse containing audit logs.
     */
    async fetchAll(
        props: PaginatedQuery
    ): Promise<FetchResponse<AuditLogEntity>> {
        const { limit, page, search } = props;

        // Parallelize data fetch and count queries for better performance
        const [auditLogs, count] = await Promise.all([
            this.auditLogRepository.findAll(withFormattedPaginatedProps(props)),
            this.auditLogRepository.count(withFormattedCountProps(props)),
        ]);

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: {
                items: auditLogs.map((auditLog: AuditLogEntity) => auditLog.id)
            }
        });
        return new FetchResponse<AuditLogEntity>({
            data: auditLogs,
            count,
            limit,
            page
        });
    }

    /**
     * Fetch all audit logs related to a specific resource.
     * Uses Promise.all to parallelize data fetch and count queries for better performance.
     * @param props - Pagination, resource type, and resource ID.
     * @returns A promise that resolves to a FetchResponse containing audit logs.
     */
    async fetchAllByResource(
        props: PaginatedQuery & { resourceType: string; resourceId: string }
    ): Promise<FetchResponse<AuditLogEntity>> {
        const { resourceType, resourceId, limit, page, search } = props;

        const whereClause = {
            resourceId,
            resourceType: resourceType as ResourceType
        };

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
                items: auditLogs.map((auditLog: AuditLogEntity) => auditLog.id)
            }
        });
        return new FetchResponse<AuditLogEntity>({
            data: auditLogs,
            count,
            limit,
            page
        });
    }

    /**
     * Fetch all audit logs created by a specific user.
     * Uses Promise.all to parallelize data fetch and count queries for better performance.
     * @param props - Pagination and user ID.
     * @returns A promise that resolves to a FetchResponse containing audit logs.
     */
    async fetchAllCreatedByUser(
        props: PaginatedQuery & { userId: string }
    ): Promise<FetchResponse<AuditLogEntity>> {
        const { userId, limit, page, search } = props;

        const whereClause = {
            responsibleUserId: userId
        };

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
                items: auditLogs.map((auditLog: AuditLogEntity) => auditLog.id)
            }
        });
        return new FetchResponse<AuditLogEntity>({
            data: auditLogs,
            count,
            limit,
            page
        });
    }

    /**
     * Fetch a specific audit log by its ID.
     * @param id - The ID of the audit log to fetch.
     * @returns A promise that resolves to the fetched AuditLogEntity.
     */
    public async fetchById(id: string): Promise<AuditLogEntity> {
        const auditLog = await this.auditLogRepository.findById(id);

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            resourceId: auditLog.id,
            data: auditLog.toObject() as object
        });
        return auditLog;
    }

    /**
     * Delete a specific audit log by its ID.
     * @param id - The ID of the audit log to delete.
     * @returns A promise that resolves to the deleted AuditLogEntity.
     */
    public async deleteById(id: string): Promise<AuditLogEntity> {
        const auditLog = await this.auditLogRepository.softDelete(id);

        this.broadcastSysEvent(SysEventType.ResourceDeleted, {
            resourceId: auditLog.id,
            data: auditLog.toObject() as object
        });
        return auditLog;
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
    async handleUserAuthenticatedEvent(event: { userId?: string; timestamp?: Date; ip?: string; userAgent?: string; method?: string } & Record<string, unknown>): Promise<void> {
        try {
            const userId = event.userId || (event as { id?: string }).id || null;
            const timestamp = event.timestamp || new Date();

            const auditLog = AuditLogFactory.CreateAuditLog({
                action: AuditAction.LOGIN,
                eventType: 'AUTHENTICATION',
                success: true,
                responsibleUserId: userId,
                responsibleIp: event.ip || this.requestIp,
                resourceId: userId,
                resourceType: ResourceType.User,
                data: {
                    method: event.method || 'oauth',
                    timestamp: timestamp.toISOString(),
                    userAgent: event.userAgent || null,
                },
                previousData: {},
                metadata: null,
                createdBy: null
            });
            await this.auditLogRepository.create(auditLog);

            this.logger.debug({
                message: 'User authenticated audit log created',
                userId,
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
