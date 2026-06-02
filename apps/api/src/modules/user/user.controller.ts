import {
  IUserService,
  IApiKeyService,
  IUserSettingsService,
  IUserRoleAssignmentService,
  PaginatedQuery,
  UserResponse,
  CreateUserRequest,
  PaginatedUserResponse,
  UpdateUserRequest,
  UserDtoMapper,
  UserSettingsResponse,
  UserSettingsDtoMapper,
  UpdateUserSettingByKeyRequest,
  HttpMethod,
  ApiKeyDtoMapper,
  PaginatedApiKeyResponse,
  UserRoleAssignmentResponse,
  UserRoleAssignmentDtoMapper,
  CreateUserRoleAssignmentRequest,
  PaginatedUserRoleAssignmentResponse,
  isSuperAdmin,
  IActiveUserContext,
} from '@arcaai/applications';
import { Body, Controller, Delete, ForbiddenException, HttpCode, HttpStatus, Inject, Param, Post, Query, Get, Patch } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiQuery, ApiResponse, ApiOperation } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { ApiEndpoint, CanManage } from '../../decorators';
import { UpdateUserStatusRequest, BulkDeleteUsersRequest, BulkDeleteUsersResponse, BulkDeleteUserFailure } from './dto';

@ApiBearerAuth()
@ApiTags('admin-users')
@Controller('admin/users')
// Phase 0 Item 3 (TASK-302 Stream A): explicit permission required.
@CanManage('User')
export class UserController {
  constructor(
    @Inject(IUserService)
    private readonly userService: IUserService,
    @Inject(IApiKeyService)
    private readonly apiKeyService: IApiKeyService,
    @Inject(IUserSettingsService)
    private readonly userSettingsService: IUserSettingsService,
    @Inject(IUserRoleAssignmentService)
    private readonly userRoleAssignmentService: IUserRoleAssignmentService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @ApiEndpoint({
    returnedModel: UserResponse,
    method: HttpMethod.POST,
  })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
  async create(@Body() request: CreateUserRequest): Promise<UserResponse> {
    const result = await this.userService.create(request);
    return UserDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: UserResponse,
    multi: true,
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  async fetchAll(@Query() queryParams: PaginatedQuery): Promise<PaginatedUserResponse> {
    // TASK-326 X2 (audit X2, Critical): pre-fix `fetchAll` applied NO tenant
    // scope, so any caller with `manage:User` (e.g. a TENANT_ADMIN) could
    // enumerate users platform-wide. Mirror the AuditLogController guard:
    // non-super-admins are routed to the by-tenant service path scoped to
    // their effective CLS tenant; SUPER_ADMIN keeps the cross-tenant read.
    const user = this.cls.get('user');
    const callerTenantId = this.cls.get('tenantId');
    if (!isSuperAdmin(user)) {
      if (!callerTenantId) {
        throw new ForbiddenException('Tenant context required to list users');
      }
      const scoped = await this.userService.fetchAllByTenantId({
        ...queryParams,
        tenantId: callerTenantId,
      });
      return UserDtoMapper.ToPaginatedResponse(scoped);
    }

    const result = await this.userService.fetchAll({
      ...queryParams,
    });
    return UserDtoMapper.ToPaginatedResponse(result);
  }

  @ApiEndpoint({
    returnedModel: UserResponse,
    path: '/:id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({ status: 404, description: 'User not found' })
  async fetchById(@Param('id') id: string): Promise<UserResponse> {
    const result = await this.userService.fetchById(id);
    return UserDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: UserResponse,
    path: 'tenant/:tenantId',
    multi: true,
    by: ['tenantId'],
  })
  @ApiParam({ name: 'tenantId', description: 'Tenant ID', type: String })
  async fetchByTenant(@Param('tenantId') tenantId: string, @Query() queryParams: PaginatedQuery): Promise<PaginatedUserResponse> {
    const result = await this.userService.fetchAllByTenantId({
      ...queryParams,
      tenantId,
    });
    return UserDtoMapper.ToPaginatedResponse(result);
  }

  @ApiEndpoint({
    returnedModel: UserResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({ status: 404, description: 'User not found' })
  async update(@Param('id') id: string, @Body() request: UpdateUserRequest): Promise<UserResponse> {
    const result = await this.userService.update(id, request);
    return UserDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: UserResponse,
    method: HttpMethod.PATCH,
    path: ':id/status',
    by: ['id'],
    append: '(enable/disable)',
  })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({ status: 404, description: 'User not found' })
  async updateStatus(@Param('id') id: string, @Body() body: UpdateUserStatusRequest): Promise<UserResponse> {
    const result = await this.userService.update(id, {
      resourceStatus: body.resourceStatus,
    } as UpdateUserRequest);
    return UserDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: UserResponse,
    method: HttpMethod.DELETE,
    path: '/:id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({ status: 404, description: 'User not found' })
  async delete(@Param('id') id: string): Promise<UserResponse> {
    const result = await this.userService.deleteById(id);
    return UserDtoMapper.ToResponse(result);
  }

  /**
   * Bulk delete users with partial-failure semantics (TASK-310 E-11 / AC-10).
   *
   * Pre-W7 this method threw on the first failing id, leaving the caller
   * with no signal about which preceding deletes had landed or which later
   * ids never ran. It now catches per-id and returns the structured
   * `BulkDeleteUsersResponse` so admin tooling can report exact partial
   * progress and retry only the failed ids idempotently.
   *
   * Why per-id catch (not a Prisma `$transaction`):
   *   - `IUserService.deleteById` doesn't accept a transaction client; the
   *     `applications` layer would need a new overload to thread one
   *     through. That's a cross-package surface change and out of scope
   *     for an apps/api hygiene sweep.
   *   - Admin UX wants visibility into _which_ id failed; transactional
   *     roll-back collapses that into a single error message.
   *
   * If a future requirement demands all-or-nothing semantics, callers can
   * inspect `failed.length > 0` and trigger their own compensating
   * workflow against the `succeeded` set.
   */
  @ApiEndpoint({
    returnedModel: BulkDeleteUsersResponse,
    method: HttpMethod.DELETE,
    path: 'bulk',
    append: '(bulk delete)',
  })
  async bulkDelete(@Body() body: BulkDeleteUsersRequest): Promise<BulkDeleteUsersResponse> {
    const succeeded: UserResponse[] = [];
    const failed: BulkDeleteUserFailure[] = [];

    for (const id of body.ids) {
      try {
        const result = await this.userService.deleteById(id);
        succeeded.push(UserDtoMapper.ToResponse(result));
      } catch (err) {
        failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return { succeeded, failed };
  }

  @ApiEndpoint({
    returnedModel: PaginatedApiKeyResponse,
    path: ':id/api-keys',
    by: ['userId'],
    multi: true,
  })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  async fetchUserApiKeys(@Param('id') id: string, @Query() queryParams: PaginatedQuery): Promise<PaginatedApiKeyResponse> {
    const result = await this.apiKeyService.fetchAllByUserId({
      ...queryParams,
      userId: id,
    });
    return ApiKeyDtoMapper.ToPaginatedResponse(result);
  }

  // -------------------------------------------------------------------------
  // TASK-245: Admin user settings management
  // -------------------------------------------------------------------------

  @Get(':id/settings')
  @ApiOperation({ summary: 'Get all settings for a specific user (admin)' })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({
    status: 200,
    description: 'User settings retrieved',
    schema: { type: 'array', items: { $ref: '#/components/schemas/UserSettingsResponse' } },
  })
  @ApiResponse({ status: 404, description: 'User not found' })
  async fetchUserSettings(@Param('id') id: string): Promise<UserSettingsResponse[]> {
    const settings = await this.userSettingsService.fetchAllByUserId(id);
    return settings.map((s) => UserSettingsDtoMapper.ToResponse(s));
  }

  @Patch(':id/settings/:namespace/:key')
  @ApiOperation({ summary: 'Upsert a setting for a specific user (admin)' })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiParam({ name: 'namespace', description: 'Setting namespace', type: String })
  @ApiParam({ name: 'key', description: 'Setting key', type: String })
  @ApiResponse({ status: 200, description: 'Setting updated', type: UserSettingsResponse })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async updateUserSetting(
    @Param('id') id: string,
    @Param('namespace') namespace: string,
    @Param('key') key: string,
    @Body() request: UpdateUserSettingByKeyRequest,
  ): Promise<UserSettingsResponse> {
    const updated = await this.userSettingsService.upsertByUserKeyNamespace(id, namespace, key, request);
    return UserSettingsDtoMapper.ToResponse(updated);
  }

  @ApiEndpoint({
    returnedModel: UserRoleAssignmentResponse,
    path: ':id/roles',
    by: ['userId'],
    multi: true,
  })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Role assignments listed', type: PaginatedUserRoleAssignmentResponse })
  async fetchUserRoleAssignments(@Param('id') id: string, @Query() queryParams: PaginatedQuery): Promise<PaginatedUserRoleAssignmentResponse> {
    const result = await this.userRoleAssignmentService.fetchAllByUserId({
      ...queryParams,
      userId: id,
    });
    return UserRoleAssignmentDtoMapper.ToPaginatedResponse(result);
  }

  @Post(':id/roles')
  @ApiOperation({ summary: 'Assign a role to a user' })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({ status: 201, description: 'Role assigned', type: UserRoleAssignmentResponse })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async assignRole(@Param('id') id: string, @Body() body: CreateUserRoleAssignmentRequest): Promise<UserRoleAssignmentResponse> {
    const result = await this.userRoleAssignmentService.create({ ...body, userId: id });
    return UserRoleAssignmentDtoMapper.ToResponse(result);
  }

  @Delete(':id/roles/:assignmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a role assignment from a user' })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiParam({ name: 'assignmentId', description: 'Role assignment ID', type: String })
  @ApiResponse({ status: 204, description: 'Role removed' })
  @ApiResponse({ status: 404, description: 'Assignment not found' })
  async removeRole(@Param('assignmentId') assignmentId: string): Promise<void> {
    await this.userRoleAssignmentService.deleteById(assignmentId);
  }
}
