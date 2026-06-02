import {
  HttpMethod,
  IAuditLogService,
  PaginatedQuery,
  PaginatedAuditLogResponse,
  AuditLogDtoMapper,
  AuditLogResponse,
  AuditLogQuery,
  isSuperAdmin,
  IActiveUserContext,
} from '@arcaai/applications';
import { Controller, ForbiddenException, Get, Header, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
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
// Phase 0 Item 3 (TASK-302 Stream A): explicit permission required.
// Read-only by design — auditors must never mutate audit data.
@CanRead('AuditLog')
export class AuditLogController {
  constructor(
    @Inject(IAuditLogService)
    private readonly auditLogService: IAuditLogService,
    private readonly cls: ClsService<IActiveUserContext>,
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
    description:
      'Returns a paginated list of audit logs. Supports the TASK-328 A8 filters ' +
      '(from/to date range, action, resourceType, userId) pushed to the database, ' +
      'and enriches each row with the resolved responsible user.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @CanRead('AuditLog')
  async fetchAll(@Query() queryParams: AuditLogQuery): Promise<PaginatedAuditLogResponse> {
    // TASK-326 X5 (audit X5): the unscoped list route is the cross-tenant
    // enumeration surface. The service `buildTenantWhere` already scopes
    // every query, but mirror the `fetchByUser` guard here so the rule is
    // observable at the request entry point and a non-super-admin with no
    // tenant context never reaches the service. SUPER_ADMIN keeps the
    // cross-tenant read.
    const user = this.cls.get('user');
    const callerTenantId = this.cls.get('tenantId');
    if (!isSuperAdmin(user) && !callerTenantId) {
      throw new ForbiddenException('Tenant context required to query audit logs');
    }

    // TASK-328 A8: filters are pushed to the repository where-clause and each
    // row is enriched with its acting user (resolved in one batch).
    const { result, responsibleUsers } = await this.auditLogService.fetchAllFiltered({
      ...queryParams,
      sort: queryParams.sort || 'createdAt:desc',
    });
    return AuditLogDtoMapper.ToPaginatedResponse(result, responsibleUsers);
  }

  /**
   * TASK-328 A8 — export the CURRENT filtered result set as CSV.
   *
   * Declared BEFORE the `/:id` route so `GET /admin/audit-logs/export` is never
   * captured as an id lookup. Honours the same filters + tenant scope as
   * {@link fetchAll}; the service materialises the full (capped) filtered set
   * server-side so the download always respects tenant boundaries.
   */
  @Get('export')
  @ApiOperation({
    summary: 'Export audit logs as CSV',
    description: 'Streams the filtered, tenant-scoped audit logs as a text/csv attachment.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'CSV export of the filtered audit logs.', schema: { type: 'string' } })
  @ApiResponse({ status: 403, description: 'Tenant context required to export audit logs' })
  @CanRead('AuditLog')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="audit-logs.csv"')
  async exportCsv(@Query() queryParams: AuditLogQuery): Promise<string> {
    const user = this.cls.get('user');
    const callerTenantId = this.cls.get('tenantId');
    if (!isSuperAdmin(user) && !callerTenantId) {
      throw new ForbiddenException('Tenant context required to export audit logs');
    }

    const { rows, responsibleUsers } = await this.auditLogService.exportFiltered(queryParams);
    return AuditLogDtoMapper.ToCsv(rows, responsibleUsers);
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
  async fetchByUser(@Param('userId') userId: string, @Query() queryParams: PaginatedQuery): Promise<PaginatedAuditLogResponse> {
    // TASK-307 W5.7 (AC-21, audit D-7): defence-in-depth tenant scope.
    // The service-side `buildTenantWhere` already throws when a
    // non-super-admin has no CLS tenantId, but the audit asks for an
    // explicit controller-layer assertion so the rule is observable at
    // the request entry point. SUPER_ADMIN keeps the cross-tenant
    // read (mirrors TASK-305 W1.4).
    const user = this.cls.get('user');
    const callerTenantId = this.cls.get('tenantId');
    if (!isSuperAdmin(user) && !callerTenantId) {
      throw new ForbiddenException('Tenant context required to query audit logs');
    }

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
