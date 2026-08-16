import {
  IAuditLogService,
  PaginatedQuery,
  PaginatedAuditLogResponse,
  AuditLogDtoMapper,
  AuditLogResponse,
  AuditLogQuery,
  AuditLogCursorQuery,
  CursorPaginatedAuditLogResponse,
  isSuperAdmin,
  IActiveUserContext,
} from '@arcaai/applications';
import { Controller, ForbiddenException, Get, Inject, Param, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { ApiEndpoint, CanRead, RequiredScopes } from '../../decorators';
import { buildTableExport } from '../../shared/table-export';

/**
 * AuditLogController - Audit log management endpoints
 *
 * Provides read-only access to audit logs for compliance and security monitoring.
 *
 * Authorization is handled via policy-based decorators:
 * - @CanRead('AuditLog') - Requires 'read' permission on 'AuditLog' resource
 *
 * Note: Audit logs are created automatically by the system when resources are
 * created, viewed, updated, or deleted. There is no manual create endpoint, and
 * no delete endpoint either — the trail is append-only/immutable for
 * compliance (HIPAA §164.312(b)). Retention/archival is a separate, audited
 * process owned outside the admin surface.
 *
 * Permissions are defined in database policies and assigned to roles.
 * See: packages/database/src/prisma/db_main/seed/01-policy.ts for default policies.
 */
@ApiTags('admin-audit-logs')
@ApiBearerAuth()
@RequiredScopes('admin:audit:read')
@Controller('admin/audit-logs')
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
      'Returns a paginated list of audit logs. Supports filters ' +
      '(from/to date range, action, resourceType, userId) pushed to the database, ' +
      'and enriches each row with the resolved responsible user.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @CanRead('AuditLog')
  async fetchAll(@Query() queryParams: AuditLogQuery): Promise<PaginatedAuditLogResponse> {
    // The unscoped list route is the cross-tenant enumeration surface. The
    // service `buildTenantWhere` already scopes every query, but mirror the
    // `fetchByUser` guard here so the rule is observable at the request entry
    // point and a non-global-admin with no tenant context never reaches the
    // service. SUPER_ADMIN keeps the cross-tenant read.
    const user = this.cls.get('user');
    const callerTenantId = this.cls.get('tenantId');
    if (!isSuperAdmin(user) && !callerTenantId) {
      throw new ForbiddenException('Tenant context required to query audit logs');
    }

    // Filters are pushed to the repository where-clause and each row is
    // enriched with its acting user (resolved in one batch).
    const { result, responsibleUsers } = await this.auditLogService.fetchAllFiltered({
      ...queryParams,
      sort: queryParams.sort || 'createdAt:desc',
    });
    return AuditLogDtoMapper.ToPaginatedResponse(result, responsibleUsers);
  }

  /**
   * Export the CURRENT filtered result set.
   *
   * Declared BEFORE the `/:id` route so `GET /admin/audit-logs/export` is never
   * captured as an id lookup. Honours the same filters + tenant scope as
   * {@link fetchAll}; the service materialises the full (capped) filtered set
   * server-side so the download always respects tenant boundaries.
   *
   * `?format=csv|xlsx|pdf` (default `csv`, unchanged legacy behaviour). `csv`
   * still serialises via {@link AuditLogDtoMapper.ToCsv}; `xlsx`/`pdf` render
   * the SAME structured rows ({@link AuditLogDtoMapper.ToExportRows}) through
   * the shared `table-export` util. Returns a {@link StreamableFile} so the
   * per-format content-type/filename are set from the payload (a static
   * `@Header('text/csv')` could not vary).
   */
  @Get('export')
  @ApiOperation({
    summary: 'Export audit logs (csv | xlsx | pdf)',
    description: 'Streams the filtered, tenant-scoped audit logs as a csv/xlsx/pdf file attachment.',
  })
  @ApiProduces('text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf')
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'xlsx', 'pdf'] })
  @ApiResponse({ status: 200, description: 'File attachment (csv/xlsx/pdf) of the filtered audit logs.' })
  @ApiResponse({ status: 403, description: 'Tenant context required to export audit logs' })
  @CanRead('AuditLog')
  async exportCsv(@Query() queryParams: AuditLogQuery): Promise<StreamableFile> {
    const user = this.cls.get('user');
    const callerTenantId = this.cls.get('tenantId');
    if (!isSuperAdmin(user) && !callerTenantId) {
      throw new ForbiddenException('Tenant context required to export audit logs');
    }

    // OB-07: a global (cross-tenant) export is a global-admin reading without
    // a tenant scope — those rows span tenants, so the export must carry a
    // tenantId column. A tenant-scoped export omits it (every row is the same
    // tenant, so the column would be noise).
    const includeTenant = isSuperAdmin(user) && !callerTenantId;
    const format = queryParams.format ?? 'csv';

    const { rows, responsibleUsers } = await this.auditLogService.exportFiltered(queryParams);

    if (format === 'csv') {
      // Preserve the exact CSV bytes (header, RFC-4180 escaping, OB-07 tenant
      // column) — just wrapped in a StreamableFile.
      const csv = AuditLogDtoMapper.ToCsv(rows, responsibleUsers, { includeTenant });
      return new StreamableFile(Buffer.from(csv, 'utf-8'), {
        type: 'text/csv; charset=utf-8',
        disposition: 'attachment; filename="audit-logs.csv"',
      });
    }

    const { columns, rows: tableRows } = AuditLogDtoMapper.ToExportRows(rows, responsibleUsers, { includeTenant });
    const file = await buildTableExport(format, {
      columns,
      rows: tableRows,
      baseName: 'audit-logs',
      title: 'Audit logs export',
      sheetName: 'Audit logs',
    });
    return new StreamableFile(file.buffer, {
      type: file.contentType,
      disposition: `attachment; filename="${file.filename}"`,
    });
  }

  /**
   * Cursor (keyset) page of the audit-log list.
   *
   * Declared BEFORE the `/:id` route so `GET /admin/audit-logs/cursor` is never
   * captured as an id lookup. The opt-in, count-free counterpart of
   * {@link fetchAll}: same A8 filters + the same tenant guard, paginated by an
   * opaque `cursor` and returning `nextCursor`/`hasMore`. The offset `fetchAll`
   * route is left untouched (clients choose per-request which to use).
   */
  @Get('cursor')
  @ApiOperation({
    summary: 'Fetch audit logs (cursor pagination)',
    description:
      'Returns a keyset (cursor) page of audit logs ordered by (createdAt, id) DESC. ' +
      "Pass the previous response's `nextCursor` to page forward; `hasMore` signals more pages. " +
      'Supports the same filters (from/to/action/resourceType/userId) as the offset list.',
  })
  @ApiOkResponse({ type: CursorPaginatedAuditLogResponse, description: 'A cursor page of audit logs.' })
  @ApiResponse({ status: 400, description: 'Invalid cursor' })
  @ApiResponse({ status: 403, description: 'Tenant context required to query audit logs' })
  @CanRead('AuditLog')
  async fetchByCursor(@Query() queryParams: AuditLogCursorQuery): Promise<CursorPaginatedAuditLogResponse> {
    // Mirror the fetchAll/fetchByUser guard so the cross-tenant enumeration
    // rule is observable at the request entry point (service buildTenantWhere
    // already enforces it). SUPER_ADMIN keeps the cross-tenant read.
    const user = this.cls.get('user');
    const callerTenantId = this.cls.get('tenantId');
    if (!isSuperAdmin(user) && !callerTenantId) {
      throw new ForbiddenException('Tenant context required to query audit logs');
    }

    const { page, responsibleUsers } = await this.auditLogService.fetchPageByCursor(queryParams);
    return AuditLogDtoMapper.ToCursorResponse(page, responsibleUsers);
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
    // Defence-in-depth tenant scope. The service-side `buildTenantWhere`
    // already throws when a non-global-admin has no CLS tenantId, but this
    // adds an explicit controller-layer assertion so the rule is observable
    // at the request entry point. SUPER_ADMIN keeps the cross-tenant read.
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

  // OB-10: the soft-delete route was removed. Audit logs are
  // append-only/immutable from the admin surface; any retention/archival must
  // be a separate, explicitly audited process — never an ad-hoc admin delete.
}
