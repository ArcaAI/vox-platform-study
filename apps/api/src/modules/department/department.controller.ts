import {
  IDepartmentService,
  DepartmentResponse,
  CreateDepartmentRequest,
  UpdateDepartmentRequest,
  UpdateDepartmentPromptConfigRequest,
  PaginatedQuery,
  PaginatedUserResponse,
  HttpMethod,
  isSuperAdmin,
  IActiveUserContext,
} from '@arcaai/applications';
import { Controller, Body, Param, Get, Inject, Query, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
// `@RequiresIfMatch()` + `@ExpectedVersion()`
// gate the OCC-enforced PATCH routes on this controller.
import { ApiEndpoint, Authorize, CanManage, RequiresIfMatch, ExpectedVersion, RequiredScopes } from '../../decorators';

@ApiBearerAuth()
@ApiTags('admin-departments')
@RequiredScopes('admin:department:manage')
@Controller('admin/departments')
@CanManage('Department')
export class DepartmentController {
  constructor(
    @Inject(IDepartmentService)
    private readonly departmentService: IDepartmentService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    method: HttpMethod.POST,
  })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input or duplicate code' })
  async create(@Body() request: CreateDepartmentRequest): Promise<DepartmentResponse> {
    return this.departmentService.create(request);
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    multi: true,
  })
  @ApiQuery({ name: 'includeDisabled', required: false, type: Boolean, description: 'Include disabled departments in results' })
  async fetchAll(@Query('includeDisabled') includeDisabled?: string): Promise<DepartmentResponse[]> {
    // `DepartmentService.getAll` already requires
    // `this.tenantId`, but mirror the AuditLogController guard so a
    // non-super-admin with no tenant context is rejected at the request
    // entry point and never reaches the service. SUPER_ADMIN bypasses here
    // (the service still enforces its own tenant rule for operators).
    const user = this.cls.get('user');
    const callerTenantId = this.cls.get('tenantId');
    if (!isSuperAdmin(user) && !callerTenantId) {
      throw new ForbiddenException('Tenant context required to list departments');
    }

    return this.departmentService.getAll({
      includeDisabled: includeDisabled === 'true',
    });
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    path: 'roots',
    multi: true,
  })
  async fetchRoots(): Promise<DepartmentResponse[]> {
    return this.departmentService.getRootDepartments();
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Department ID', type: String })
  @ApiResponse({ status: 404, description: 'Department not found' })
  async fetchById(@Param('id') id: string): Promise<DepartmentResponse | null> {
    return this.departmentService.getById(id);
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    path: 'code/:code',
    by: ['code'],
  })
  @ApiParam({ name: 'code', description: 'Department code', type: String })
  @ApiResponse({ status: 404, description: 'Department not found' })
  async fetchByCode(@Param('code') code: string): Promise<DepartmentResponse | null> {
    return this.departmentService.getByCode(code);
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    path: ':id/children',
    by: ['id'],
    multi: true,
  })
  @ApiParam({ name: 'id', description: 'Parent department ID', type: String })
  async fetchChildren(@Param('id') id: string): Promise<DepartmentResponse[]> {
    return this.departmentService.getChildren(id);
  }

  // Reverse dept->users listing (previously derived
  // client-side). Tenant-scoped inside the service (no-existence-leak 404 on a
  // cross-tenant department; SUPER_ADMIN cross-tenant bypass) and paginated with
  // the house `PaginatedQuery`. Class-level `@CanManage('Department')` gates it.
  @Get(':id/users')
  @ApiOperation({ summary: "List a department's members (users)" })
  @ApiParam({ name: 'id', description: 'Department ID', type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated department members', type: PaginatedUserResponse })
  @ApiResponse({ status: 404, description: 'Department not found' })
  async fetchUsers(@Param('id') id: string, @Query() queryParams: PaginatedQuery): Promise<PaginatedUserResponse> {
    return this.departmentService.getDepartmentUsers(id, queryParams);
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update department',
    description:
      'Updates one department row. Optimistic concurrency is enforced: ' +
      'the `If-Match` header (RFC 7232) is REQUIRED, and the server runs a Compare-And-Set ' +
      "against the row's `_version`. When the header is present, its value overrides the " +
      'body-field `expectedVersion`. On version drift the response is `412 Precondition Failed`; ' +
      'missing header is `428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Department ID', type: String })
  @ApiResponse({ status: 404, description: 'Department not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateDepartmentRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<DepartmentResponse> {
    // Header takes precedence over body
    // when both are present. On a `@RequiresIfMatch()` route the param
    // decorator fired 428 if the header was missing, so the fallback
    // only fires in unit tests / off-route service-to-service traffic.
    const effectiveRequest: UpdateDepartmentRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.departmentService.update(id, effectiveRequest);
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    method: HttpMethod.PATCH,
    path: ':id/prompt-config',
    by: ['id'],
    append: '(prompt config)',
  })
  @Authorize(['manage', 'Department'])
  @RequiresIfMatch()
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Department ID', type: String })
  @ApiResponse({ status: 404, description: 'Department not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async updatePromptConfig(
    @Param('id') id: string,
    @Body() request: UpdateDepartmentPromptConfigRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<DepartmentResponse> {
    const effectiveRequest: UpdateDepartmentPromptConfigRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.departmentService.updatePromptConfig(id, effectiveRequest);
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    method: HttpMethod.DELETE,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Department ID', type: String })
  @ApiResponse({ status: 400, description: 'Cannot delete department with children' })
  @ApiResponse({ status: 404, description: 'Department not found' })
  async delete(@Param('id') id: string): Promise<DepartmentResponse> {
    return this.departmentService.deleteById(id);
  }
}
