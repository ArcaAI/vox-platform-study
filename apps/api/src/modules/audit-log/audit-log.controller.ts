import {
    HttpMethod,
    IAuditLogService,
    PaginatedQuery,
    PaginatedAuditLogResponse,
    AuditLogDtoMapper,
    AuditLogResponse,
} from '@arcaai/applications';
import { Controller, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint, CanRead, CanDelete } from '../../decorators';

/**
 * AuditLogController - Audit log management endpoints
 *
 * Provides read-only access to audit logs for compliance and security monitoring.
 *
 * Authorization is handled via policy-based decorators:
 * - @CanRead('AuditLog') - Requires 'read' permission on 'AuditLog' resource
 * - @CanDelete('AuditLog') - Requires 'delete' permission on 'AuditLog' resource
 *
 * Note: Audit logs are created automatically by the system when resources are
 * created, viewed, updated, or deleted. There is no manual create endpoint.
 *
 * Permissions are defined in database policies and assigned to roles.
 * See: packages/database/src/prisma/db_main/seed/01-policy.ts for default policies.
 */
@ApiTags('admin-audit-logs')
@ApiBearerAuth()
@Controller('admin/audit-logs')
export class AuditLogController {
    constructor(
        @Inject(IAuditLogService)
        private readonly auditLogService: IAuditLogService,
    ) {}

    /**
     * Fetch all audit logs with pagination and optional search
     */
    @ApiEndpoint({
        returnedModel: AuditLogResponse,
        multi: true,
    })
    @ApiOperation({
        summary: 'Fetch all audit logs',
        description: 'Returns a paginated list of audit logs. Supports search filtering.',
    })
    @ApiQuery({ name: 'page', required: false, type: Number })
    @ApiQuery({ name: 'pageSize', required: false, type: Number })
    @CanRead('AuditLog')
    async fetchAll(@Query() queryParams: PaginatedQuery): Promise<PaginatedAuditLogResponse> {
        const result = await this.auditLogService.fetchAll({
            ...queryParams,
            sort: queryParams.sort || 'createdAt:desc',
        });
        return AuditLogDtoMapper.ToPaginatedResponse(result);
    }

    /**
     * Fetch a specific audit log by ID
     */
    @ApiEndpoint({
        returnedModel: AuditLogResponse,
        path: '/:id',
        by: ['id'],
    })
    @ApiOperation({
        summary: 'Fetch audit log by ID',
        description: 'Returns a single audit log entry by its unique identifier.',
    })
    @ApiParam({
        name: 'id',
        description: 'The unique identifier of the audit log',
        type: String,
    })
    @ApiResponse({ status: 404, description: 'Audit log not found' })
    @CanRead('AuditLog')
    async fetchById(@Param('id') id: string): Promise<AuditLogResponse> {
        const result = await this.auditLogService.fetchById(id);
        return AuditLogDtoMapper.ToResponse(result);
    }

    /**
     * Fetch audit logs for a specific resource
     */
    @ApiEndpoint({
        returnedModel: AuditLogResponse,
        multi: true,
        path: '/resource/:resourceType/:resourceId',
    })
    @ApiOperation({
        summary: 'Fetch audit logs by resource',
        description: 'Returns all audit logs related to a specific resource type and ID.',
    })
    @ApiParam({
        name: 'resourceType',
        description: 'The type of resource (e.g., User, Consultation, Tag)',
        type: String,
    })
    @ApiParam({
        name: 'resourceId',
        description: 'The unique identifier of the resource',
        type: String,
    })
    @CanRead('AuditLog')
    async fetchByResource(
        @Param('resourceType') resourceType: string,
        @Param('resourceId') resourceId: string,
        @Query() queryParams: PaginatedQuery,
    ): Promise<PaginatedAuditLogResponse> {
        const result = await this.auditLogService.fetchAllByResource({
            ...queryParams,
            resourceType,
            resourceId,
            sort: queryParams.sort || 'createdAt:desc',
        });
        return AuditLogDtoMapper.ToPaginatedResponse(result);
    }

    /**
     * Fetch audit logs created by a specific user
     */
    @ApiEndpoint({
        returnedModel: AuditLogResponse,
        multi: true,
        path: '/user/:userId',
    })
    @ApiOperation({
        summary: 'Fetch audit logs by user',
        description: 'Returns all audit logs created by a specific user (responsibleUserId).',
    })
    @ApiParam({
        name: 'userId',
        description: 'The unique identifier of the user who performed the actions',
        type: String,
    })
    @CanRead('AuditLog')
    async fetchByUser(
        @Param('userId') userId: string,
        @Query() queryParams: PaginatedQuery,
    ): Promise<PaginatedAuditLogResponse> {
        const result = await this.auditLogService.fetchAllCreatedByUser({
            ...queryParams,
            userId,
            sort: queryParams.sort || 'createdAt:desc',
        });
        return AuditLogDtoMapper.ToPaginatedResponse(result);
    }

    /**
     * Soft delete an audit log (for compliance, typically restricted)
     */
    @ApiEndpoint({
        returnedModel: AuditLogResponse,
        method: HttpMethod.DELETE,
        path: '/:id',
        by: ['id'],
    })
    @ApiOperation({
        summary: 'Delete audit log',
        description: 'Soft deletes an audit log entry. This action is typically restricted to super admins for compliance reasons.',
    })
    @ApiParam({
        name: 'id',
        description: 'The unique identifier of the audit log to delete',
        type: String,
    })
    @ApiResponse({ status: 404, description: 'Audit log not found' })
    @CanDelete('AuditLog')
    async delete(@Param('id') id: string): Promise<AuditLogResponse> {
        const result = await this.auditLogService.deleteById(id);
        return AuditLogDtoMapper.ToResponse(result);
    }
}
