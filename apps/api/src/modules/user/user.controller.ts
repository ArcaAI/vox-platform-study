import {
  IUserService,
  IApiKeyService,
  IUserSettingsService,
  IUserRoleAssignmentService,
  IUserDepartmentService,
  SetUserDepartmentsRequest,
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
  UserPasswordService,
  ResetPasswordRequest,
  ResetPasswordResponse,
  type AppAbility,
  type UserExportEnrichment,
} from '@arcaai/applications';
import {
  BadRequestException,
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
  StreamableFile,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiQuery, ApiResponse, ApiOperation } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { ApiEndpoint, CanManage, UserAbility } from '../../decorators';
import {
  UpdateUserStatusRequest,
  BulkDeleteUsersRequest,
  BulkDeleteUsersResponse,
  BulkDeleteUserFailure,
  BulkUserActionRequest,
  BulkUserActionResponse,
  BulkUserActionItemResult,
  ExportUsersQuery,
} from './dto';
import { UserExportService, UserExportRow } from './user-export.service';
import { VoiceProfileResponse } from '../voice-profile/dto/voice-profile.response';

/**
 * Default ordering for the admin Users list.
 *
 * The CSV `filters`/`sort`/`search` from the shared `PaginatedQuery` already
 * flow through `UserService` → `Repository.findAll`, but with NO `sort` the
 * underlying offset query has an undefined row order, so server-side paging
 * from the admin grid is non-deterministic. Default to newest-first (mirrors
 * `AuditLogController`); any client-supplied `sort` takes precedence.
 */
const DEFAULT_USERS_SORT = 'createdAt:desc';

@ApiBearerAuth()
@ApiTags('admin-users')
@Controller('admin/users')
@CanManage('User')
export class UserController {
  /** Hard cap on export rows (FLAG: large tenants stream/paginate in a follow-up). */
  private static readonly EXPORT_LIMIT = 10000;

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
    @Inject(IUserDepartmentService)
    private readonly userDepartmentService: IUserDepartmentService,
    private readonly userPasswordService: UserPasswordService,
    private readonly userExportService: UserExportService,
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

  // Bulk reconcile a user's department memberships. Backs the SDK
  // `useUsers.assignDepartments` ({ departmentIds, primaryDepartmentId }) used by
  // the Create-User dialog's initial departments and the bulk "Assign department"
  // action; returns the updated user so the client can refresh its row.
  @Patch(':id/departments')
  @ApiOperation({ summary: "Set a user's department memberships (bulk reconcile)" })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({ status: 200, description: 'Updated user', type: UserResponse })
  @ApiResponse({ status: 404, description: 'User or a target department not found (or cross-tenant)' })
  async setDepartments(@Param('id') id: string, @Body() request: SetUserDepartmentsRequest): Promise<UserResponse> {
    await this.assertUserInScope(id);
    await this.userDepartmentService.setDepartments(id, request);
    const user = await this.userService.fetchById(id);
    return UserDtoMapper.ToResponse(user);
  }

  @ApiEndpoint({
    returnedModel: UserResponse,
    multi: true,
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  async fetchAll(@Query() queryParams: PaginatedQuery): Promise<PaginatedUserResponse> {
    // Tenant-scope guard: mirrors the AuditLogController guard — non-global-admins
    // are routed to the by-tenant service path scoped to their effective CLS
    // tenant; GLOBAL_ADMIN keeps the cross-tenant read (prevents platform-wide
    // user enumeration by non-global-admins).
    const user = this.cls.get('user');
    const callerTenantId = this.cls.get('tenantId');
    // Apply the deterministic default sort once, before any scoping branch, so
    // every path pages stably.
    const params = this.withDefaultSort(queryParams);
    if (!isSuperAdmin(user)) {
      if (!callerTenantId) {
        throw new ForbiddenException('Tenant context required to list users');
      }
      const scoped = await this.userService.fetchAllByTenantId({
        ...params,
        tenantId: callerTenantId,
      });
      return UserDtoMapper.ToPaginatedResponse(scoped);
    }

    // When a global-admin selects a tenant in the console, the ContextInterceptor
    // elevates `x-tenant-id` into CLS `tenantId`. Honour it and scope the listing
    // to that tenant; with no selection the platform-wide cross-tenant listing
    // is preserved.
    if (callerTenantId) {
      const scoped = await this.userService.fetchAllByTenantId({
        ...params,
        tenantId: callerTenantId,
      });
      return UserDtoMapper.ToPaginatedResponse(scoped);
    }

    const result = await this.userService.fetchAll({
      ...params,
    });
    return UserDtoMapper.ToPaginatedResponse(result);
  }

  /**
   * Fill in {@link DEFAULT_USERS_SORT} when the caller supplies no
   * `sort`, leaving an explicit `sort` (and all other CSV `filters`/`search`
   * params) untouched. `||` (not `??`) also defaults an empty-string sort,
   * which `deserializeSortString` would otherwise treat as "no order".
   */
  private withDefaultSort(queryParams: PaginatedQuery): PaginatedQuery {
    return { ...queryParams, sort: queryParams.sort || DEFAULT_USERS_SORT };
  }

  // -------------------------------------------------------------------------
  // Server-side export (csv | xlsx | pdf).
  //
  // Declared BEFORE the `/:id` route so `GET /admin/users/export` is never
  // captured as an id lookup (mirrors AuditLogController.exportCsv). Honours the
  // SAME tenant scope + CSV filters/sort as `fetchAll`; the set is materialised
  // server-side (capped) so the download always respects tenant boundaries.
  // -------------------------------------------------------------------------
  @Get('export')
  @ApiOperation({
    summary: 'Export users (csv | xlsx | pdf)',
    description:
      'Streams the tenant-scoped Users list as a file attachment, honouring the same filters/sort/search as the list. ' +
      `Capped at ${UserController.EXPORT_LIMIT} rows (FLAG). CASL-gated by the class-level manage:User.`,
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'xlsx', 'pdf'] })
  @ApiResponse({ status: 200, description: 'File attachment (csv/xlsx/pdf)' })
  @ApiResponse({ status: 403, description: 'Tenant context required to export users' })
  async exportUsers(@Query() query: ExportUsersQuery): Promise<StreamableFile> {
    const rows = await this.collectExportRows(query);
    const file = await this.userExportService.build(query.format ?? 'csv', rows);
    return new StreamableFile(file.buffer, {
      type: file.contentType,
      disposition: `attachment; filename="${file.filename}"`,
    });
  }

  /**
   * Materialise the tenant-scoped (capped) user set for an export, applying the
   * exact scoping branches as {@link fetchAll}: a non-global-admin is pinned to
   * their CLS tenant (403 with no context); a global-admin honours an elevated
   * `X-Tenant-Id` selection, else reads cross-tenant.
   *
   * Rows are enriched with email + department NAMES via ONE
   * batched `getExportEnrichment(allIds)` call (two grouped `findMany`s joined
   * in memory inside the service) so the export never fans out per-user
   * (no N+1). The list DTO itself is unchanged — this is export-path only.
   */
  private async collectExportRows(query: ExportUsersQuery): Promise<UserExportRow[]> {
    const user = this.cls.get('user');
    const callerTenantId = this.cls.get('tenantId');
    const params = this.withDefaultSort({ ...query, page: 1, limit: UserController.EXPORT_LIMIT });

    let result;
    if (query.tenantId) {
      // Explicit tenant scope from the in-page tenant filter. Same guard as the
      // by-tenant list route: GLOBAL_ADMIN may export any tenant, every other
      // caller only their own CLS tenant.
      this.assertCanReadTenant(query.tenantId);
      result = await this.userService.fetchAllByTenantId({ ...params, tenantId: query.tenantId });
    } else if (!isSuperAdmin(user)) {
      if (!callerTenantId) {
        throw new ForbiddenException('Tenant context required to export users');
      }
      result = await this.userService.fetchAllByTenantId({ ...params, tenantId: callerTenantId });
    } else if (callerTenantId) {
      result = await this.userService.fetchAllByTenantId({ ...params, tenantId: callerTenantId });
    } else {
      result = await this.userService.fetchAll(params);
    }

    const ids = result.data.map((entity) => entity.id);
    const enrichment = await this.userService.getExportEnrichment(ids, query.tenantId ?? callerTenantId);

    return result.data.map((entity) => this.toExportRow(UserDtoMapper.ToResponse(entity), enrichment[entity.id]));
  }

  /**
   * Map a `UserResponse` (+ its enrichment) to a flat export row.
   * `email`/`departments` come from the batched enrichment lookup — the list
   * DTO still doesn't carry them; a user with no profile/memberships renders
   * blank. `status` stays defensive: `resourceStatus` is on the entity but not
   * typed on the response.
   */
  private toExportRow(r: UserResponse, enrichment?: UserExportEnrichment): UserExportRow {
    const raw = r as unknown as { resourceStatus?: string };
    return {
      id: r.id,
      username: r.username,
      email: enrichment?.email ?? '',
      type: r.isServiceAccount ? 'Service account' : 'User',
      status: raw.resourceStatus ?? '',
      departments: enrichment?.departmentNames?.join(', ') ?? '',
    };
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
    // Tenant-scope guard: the class-level `@CanManage('User')` action check does
    // NOT constrain WHICH tenant, so this route asserts it explicitly. Mirrors
    // `fetchAll`: a non-global-admin may only read their own CLS tenant;
    // GLOBAL_ADMIN keeps the cross-tenant read.
    this.assertCanReadTenant(tenantId);

    const result = await this.userService.fetchAllByTenantId({
      ...this.withDefaultSort(queryParams),
      tenantId,
    });
    return UserDtoMapper.ToPaginatedResponse(result);
  }

  /**
   * Shared caller-tenant guard for the by-tenant read routes. GLOBAL_ADMIN
   * reads any tenant; every other `manage:User` holder is confined to their
   * own CLS tenant. Throws `ForbiddenException` otherwise.
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
   * Shared caller-tenant guard for the by-id User routes
   * (read/mutate/profile/settings/sub-resource). Unlike the LIST routes
   * (which scope by an explicit `tenantId`), these accept a raw user
   * UUID, and the `User` model is intentionally NOT tenant-scoped at the
   * Prisma extension level — so the TARGET user's tenant membership must be
   * asserted explicitly. Resolves the target's ENABLED tenant memberships via
   * `UserRoleAssignment` and throws `NotFoundException` (404, NOT 403, to avoid
   * disclosing the existence of a cross-tenant user) when the caller's active
   * tenant is not among them. GLOBAL_ADMIN is platform-wide and exempt.
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
   * Bulk delete users with partial-failure semantics: per-id catch (not a
   * `throw` on the first failure), returning the structured
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
        // Validate EVERY id; a cross-tenant target throws `NotFoundException`
        // here and is captured under `failed` (never deleted), preserving the
        // partial-failure contract.
        await this.assertUserInScope(id);
        const result = await this.userService.deleteById(id);
        succeeded.push(UserDtoMapper.ToResponse(result));
      } catch (err) {
        failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return { succeeded, failed };
  }

  /**
   * Server-side bulk user actions with per-item partial-failure semantics.
   * Replaces the client `Promise.allSettled` loop on the admin Users surface
   * with a single endpoint so one round-trip mutates N users and the caller
   * learns exactly which ids failed.
   *
   * Every id is validated through the same by-id tenant-scope guard as the
   * single-user routes (`assertUserInScope`), so a cross-tenant target is
   * recorded under the failed set (404) and is never mutated. The loop mirrors
   * the existing `bulkDelete` precedent (per-id catch, no early throw, no
   * `$transaction`) — see that method for the rationale.
   *
   * Action set: enable | disable | delete | assign-departments | assign-role.
   *
   * `assign-role` mirrors the permission posture of the single-user
   * `POST :id/roles` route. That route swaps the class-level `manage:User` for
   * `manage:UserRoleAssignment` via a method-level `@CanManage` override; here
   * a decorator would (wrongly) re-gate ALL arms, so the same check runs
   * imperatively against the request ability — only for the assign-role arm,
   * and BEFORE any mutation. Per-item tier/tenant guards then run inside
   * `userRoleAssignmentService.create` exactly as on the single-user route.
   */
  @Post('bulk-actions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply a bulk action (enable/disable/delete/assign-departments/assign-role) to many users',
    description:
      'Per-item success/failure; the call never throws mid-batch. Each id is tenant-scope-guarded (a cross-tenant ' +
      'id is reported as failed, not mutated). CASL-gated by the class-level manage:User; the assign-role arm ' +
      'additionally requires manage:UserRoleAssignment (matching the permission on POST :id/roles).',
  })
  @ApiResponse({ status: 200, description: 'Per-item results', type: BulkUserActionResponse })
  async bulkActions(@Body() body: BulkUserActionRequest, @UserAbility() ability?: AppAbility): Promise<BulkUserActionResponse> {
    if (body.action === 'assign-role') {
      if (!ability?.can('manage', 'UserRoleAssignment')) {
        throw new ForbiddenException('You do not have permission to assign roles');
      }
      if (!body.roleId) {
        throw new BadRequestException('roleId is required for the assign-role action');
      }
    }

    const results: BulkUserActionItemResult[] = [];

    for (const id of body.ids) {
      try {
        await this.assertUserInScope(id);
        await this.applyBulkAction(id, body);
        results.push({ id, success: true });
      } catch (err) {
        results.push({ id, success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    return {
      action: body.action,
      total: body.ids.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    };
  }

  /** Dispatch a single bulk action to the owning service. Throws propagate to the per-id catch. */
  private async applyBulkAction(id: string, body: BulkUserActionRequest): Promise<void> {
    switch (body.action) {
      case 'enable':
        await this.userService.update(id, { resourceStatus: 'ENABLED' } as UpdateUserRequest);
        return;
      case 'disable':
        await this.userService.update(id, { resourceStatus: 'DISABLED' } as UpdateUserRequest);
        return;
      case 'delete':
        await this.userService.deleteById(id);
        return;
      case 'assign-departments':
        await this.userDepartmentService.setDepartments(id, {
          departmentIds: body.departmentIds ?? [],
          primaryDepartmentId: body.primaryDepartmentId,
        } as SetUserDepartmentsRequest);
        return;
      case 'assign-role':
        // Same call shape as the single-user `assignRole`; the service's
        // tier-ceiling and caller-tenant-containment guards throw here
        // and surface as this item's per-id failure.
        await this.userRoleAssignmentService.create({ roleId: body.roleId, userId: id } as CreateUserRoleAssignmentRequest);
        return;
    }
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
  // Admin user settings management
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

  // -------------------------------------------------------------------------
  // Admin reset-password (both flows)
  // -------------------------------------------------------------------------

  @Post(':id/reset-password')
  @ApiOperation({
    summary: 'Reset a user password (admin): set a temporary password OR mint an emailed reset link',
    description:
      'mode="temporary" sets (or generates) a login-compatible temporary password and returns the plaintext to convey ' +
      'out-of-band. mode="link" (default) mints a single-use, expiring reset token, best-effort emails it, and also ' +
      'returns the token/link so the flow works when email is unconfigured. Tenant-scoped + CASL-gated (manage:User).',
  })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({ status: 200, description: 'Reset performed', type: ResetPasswordResponse })
  @ApiResponse({ status: 404, description: 'User not found (or cross-tenant)' })
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Param('id') id: string, @Body() request: ResetPasswordRequest): Promise<ResetPasswordResponse> {
    await this.assertUserInScope(id);
    if (request.mode === 'temporary') {
      const { temporaryPassword } = await this.userPasswordService.setTemporaryPassword(id, {
        temporaryPassword: request.temporaryPassword,
      });
      return new ResetPasswordResponse({ mode: 'temporary', temporaryPassword });
    }
    const link = await this.userPasswordService.createResetLink(id);
    return new ResetPasswordResponse({
      mode: 'link',
      token: link.token,
      resetPath: link.resetPath,
      expiresInSeconds: link.expiresInSeconds,
      emailSent: link.emailSent,
    });
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
  // A role-assignment route must be gated by the permission that governs
  // the resource it mutates, NOT the
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
  // Admin user profile (incl. preferredPromptTemplateId)
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
