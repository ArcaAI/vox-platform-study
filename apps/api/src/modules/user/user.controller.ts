import {
  IUserService,
  IApiKeyService,
  IUserSettingsService,
  IUserRoleAssignmentService,
  IUserProfileService,
  UpdateUserProfileRequest,
  UserProfileResponse,
  UserProfileDtoMapper,
  IVoiceProfileService,
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
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Get,
  Patch,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiQuery, ApiResponse, ApiOperation } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { ApiEndpoint, CanManage } from '../../decorators';
import { UpdateUserStatusRequest, BulkDeleteUsersRequest, BulkDeleteUsersResponse, BulkDeleteUserFailure } from './dto';
import { VoiceProfileResponse } from '../voice-profile/dto/voice-profile.response';

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
    @Inject(IUserProfileService)
    private readonly userProfileService: IUserProfileService,
    @Inject(IVoiceProfileService)
    private readonly voiceProfileService: IVoiceProfileService,
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

    // AC-07 (TASK-336): when a super-admin selects a tenant in the console, the
    // ContextInterceptor elevates `x-tenant-id` into CLS `tenantId`. Honour it
    // and scope the listing to that tenant; with no selection the platform-wide
    // cross-tenant listing is preserved.
    if (callerTenantId) {
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
    await this.assertUserInScope(id);
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
    // TASK-331 r2605 #2 (Critical, IDOR): the X2 hardening scoped `fetchAll`
    // but left this sibling path-param route with only the class-level
    // `@CanManage('User')` action check — which does NOT constrain WHICH
    // tenant. Any `manage:User` holder (e.g. a TENANT_ADMIN) could enumerate
    // any tenant's users by UUID. Mirror `fetchAll`: a non-super-admin may
    // only read their own CLS tenant; SUPER_ADMIN keeps the cross-tenant read.
    this.assertCanReadTenant(tenantId);

    const result = await this.userService.fetchAllByTenantId({
      ...queryParams,
      tenantId,
    });
    return UserDtoMapper.ToPaginatedResponse(result);
  }

  /**
   * TASK-331 r2605 #2 — shared caller-tenant guard for the by-tenant read
   * routes. SUPER_ADMIN reads any tenant; every other `manage:User` holder is
   * confined to their own CLS tenant. Throws `ForbiddenException` otherwise.
   */
  private assertCanReadTenant(tenantId: string): void {
    const user = this.cls.get('user');
    if (isSuperAdmin(user)) {
      return;
    }
    const callerTenantId = this.cls.get('tenantId');
    if (!callerTenantId || callerTenantId !== tenantId) {
      throw new ForbiddenException('You can only list users within your own tenant');
    }
  }

  /**
   * AC-01 r2605 (Critical, IDOR) — shared caller-tenant guard for the by-id
   * User routes (read/mutate/profile/settings/sub-resource). Unlike the LIST
   * routes (which scope by an explicit `tenantId`), these accept a raw user
   * UUID, and the `User` model is intentionally NOT tenant-scoped at the
   * Prisma extension level — so the TARGET user's tenant membership must be
   * asserted explicitly. Resolves the target's ENABLED tenant memberships via
   * `UserRoleAssignment` and throws `NotFoundException` (404, NOT 403, to avoid
   * disclosing the existence of a cross-tenant user) when the caller's active
   * tenant is not among them. SUPER_ADMIN is platform-wide and exempt.
   */
  private async assertUserInScope(id: string): Promise<void> {
    const user = this.cls.get('user');
    if (isSuperAdmin(user)) {
      return;
    }
    const callerTenantId = this.cls.get('tenantId');
    if (!callerTenantId) {
      throw new NotFoundException('User not found');
    }
    const tenantIds = await this.userRoleAssignmentService.findActiveTenantIdsForUser(id);
    if (!tenantIds.includes(callerTenantId)) {
      throw new NotFoundException('User not found');
    }
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
    await this.assertUserInScope(id);
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
    await this.assertUserInScope(id);
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
    await this.assertUserInScope(id);
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
        // AC-01 r2605 — validate EVERY id; a cross-tenant target throws
        // `NotFoundException` here and is captured under `failed` (never
        // deleted), preserving the partial-failure contract.
        await this.assertUserInScope(id);
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
    await this.assertUserInScope(id);
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
    await this.assertUserInScope(id);
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
    await this.assertUserInScope(id);
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
    await this.assertUserInScope(id);
    const result = await this.userRoleAssignmentService.fetchAllByUserId({
      ...queryParams,
      userId: id,
    });
    return UserRoleAssignmentDtoMapper.ToPaginatedResponse(result);
  }

  @Post(':id/roles')
  // AC-02 r2605 (Critical, privilege escalation) — a role-assignment route must
  // be gated by the permission that governs the resource it mutates, NOT the
  // inherited class-level `manage:User`. `manage:UserRoleAssignment` matches the
  // `rbac-*` policy seed; this method-level decorator overrides the class-level
  // one via `Reflector.getAllAndOverride([handler, class])`.
  @CanManage('UserRoleAssignment')
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

  // -------------------------------------------------------------------------
  // TASK-328 A1–A3: Admin user profile (incl. preferredPromptTemplateId)
  // -------------------------------------------------------------------------

  @Get(':id/profile')
  @ApiOperation({ summary: "Get a user's profile (admin)" })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({ status: 200, description: 'Profile retrieved (null when none exists)', type: UserProfileResponse })
  async fetchUserProfile(@Param('id') id: string): Promise<UserProfileResponse | null> {
    await this.assertUserInScope(id);
    const profile = await this.userProfileService.getByUserId(id);
    return profile ? UserProfileDtoMapper.ToResponse(profile) : null;
  }

  @Patch(':id/profile')
  @ApiOperation({ summary: "Create or update a user's profile, incl. preferred prompt template (admin)" })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({ status: 200, description: 'Profile upserted', type: UserProfileResponse })
  async updateUserProfile(@Param('id') id: string, @Body() request: UpdateUserProfileRequest): Promise<UserProfileResponse> {
    await this.assertUserInScope(id);
    const updated = await this.userProfileService.upsertByUserId(id, request);
    return UserProfileDtoMapper.ToResponse(updated);
  }

  @Get(':id/voice-profiles')
  @ApiOperation({ summary: "List a user's enrolled voice profiles (admin, read-only)" })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({ status: 200, description: 'Enrolled voice profiles', type: [VoiceProfileResponse] })
  async fetchUserVoiceProfiles(@Param('id') id: string): Promise<VoiceProfileResponse[]> {
    await this.assertUserInScope(id);
    const profiles = await this.voiceProfileService.listByUserId(id);
    return profiles.map(VoiceProfileResponse.fromEntity);
  }
}
