import {
  GlobalSettingDtoMapper,
  GlobalSettingResponse,
  PaginatedGlobalSettingResponse,
  CreateGlobalSettingRequest,
  UpdateGlobalSettingRequest,
  RevealGlobalSettingRequest,
  RevealGlobalSettingResponse,
  RotateGlobalSettingRequest,
  ListGlobalSettingQuery,
  PaginatedQuery,
  IActiveUserContext,
  IGlobalSettingService,
  HttpMethod,
} from '@arcaai/applications';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { ApiEndpoint, Authorize, CanCreate, CanManage, CanRead, CanUpdate, CanDelete, ExpectedVersion, RequiresIfMatch } from '../../decorators';

/**
 * Global-settings admin CRUD.
 *
 * Thin delegation surface over the already-existing `GlobalSettingService`
 * (create / fetchAll / fetchAllByTenantId / fetchById / update / softDelete),
 * mirroring `ai-model-admin.controller.ts` (OCC) + `api-key.controller.ts`
 * (entity→DTO mapping). No schema change — the `GlobalSetting` model + domain
 * + service + SDK hook (`useGlobalSettings`) already exist; this only wires the
 * HTTP surface the SDK's `GLOBAL_SETTINGS_ENDPOINTS` targets.
 *
 * Mount path is `admin/settings` (not `admin/global-settings`) to match the
 * existing, tested SDK contract.
 *
 * Authorization: class-level `manage:GlobalSetting` (global-admin via
 * `manage:all`; tenant admins via the seeded `tenant-full-access` /
 * `global-settings-manage` policies, tenant-scoped). GET routes relax to
 * `read:GlobalSetting`. OCC on PATCH via the `If-Match` header (the global
 * `ETagInterceptor` emits `ETag: "<version>"` on the single-object GET).
 * `locked` platform-owned rows stay global-admin-only (enforced in the service).
 */
@ApiBearerAuth()
@ApiTags('admin-global-settings')
@Controller('admin/settings')
@CanManage('GlobalSetting')
export class GlobalSettingController {
  constructor(
    @Inject(IGlobalSettingService)
    private readonly globalSettingService: IGlobalSettingService,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  @ApiEndpoint({
    returnedModel: GlobalSettingResponse,
    method: HttpMethod.POST,
  })
  @ApiResponse({ status: 201, description: 'Global setting created', type: GlobalSettingResponse })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
  @CanCreate('GlobalSetting')
  async create(@Body() request: CreateGlobalSettingRequest): Promise<GlobalSettingResponse> {
    const result = await this.globalSettingService.create(request);
    return GlobalSettingDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: GlobalSettingResponse,
    multi: true,
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'secretsOnly',
    required: false,
    type: Boolean,
    description: 'Facet on the DERIVED secret predicate (not a column): true = secrets only, false = non-secrets only.',
  })
  @CanRead('GlobalSetting')
  async fetchAll(@Query() queryParams: ListGlobalSettingQuery): Promise<PaginatedGlobalSettingResponse> {
    // Tenant-scope like api-key.fetchAll: a tenant-bound caller sees only its
    // own settings; an unscoped (platform) caller sees all. The Prisma
    // tenant-scope extension is the backstop.
    const tenantId = this.clsService.get('tenantId');
    const result = tenantId
      ? await this.globalSettingService.fetchAllByTenantId({ ...queryParams, tenantId })
      : await this.globalSettingService.fetchAll(queryParams);
    return GlobalSettingDtoMapper.ToPaginatedResponse(result);
  }

  // Declared BEFORE `:id` so the static `tenant` segment is not shadowed.
  @Get('tenant/:tenantId')
  @ApiOperation({ summary: 'List global settings for a specific tenant' })
  @ApiParam({ name: 'tenantId', description: 'Tenant ID', type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Tenant global settings', type: PaginatedGlobalSettingResponse })
  @CanRead('GlobalSetting')
  async fetchByTenant(@Param('tenantId') tenantId: string, @Query() queryParams: PaginatedQuery): Promise<PaginatedGlobalSettingResponse> {
    const result = await this.globalSettingService.fetchAllByTenantId({ ...queryParams, tenantId });
    return GlobalSettingDtoMapper.ToPaginatedResponse(result);
  }

  @ApiEndpoint({
    returnedModel: GlobalSettingResponse,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Global setting ID', type: String })
  @ApiResponse({ status: 404, description: 'Global setting not found' })
  @CanRead('GlobalSetting')
  async fetchById(@Param('id') id: string): Promise<GlobalSettingResponse> {
    const result = await this.globalSettingService.fetchById(id);
    return GlobalSettingDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: GlobalSettingResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a global setting',
    description:
      'Updates one GlobalSetting row. Optimistic concurrency is enforced: the ' +
      '`If-Match` header (RFC 7232) is REQUIRED and the server runs a ' +
      "Compare-And-Set against the row's `_version` column. When the header is " +
      'present, its value overrides the body-field `expectedVersion`. On ' +
      'version drift the response is `412 Precondition Failed`; a missing ' +
      'header is `428 Precondition Required`. `locked` rows are global-admin-only.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the row version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Global setting ID', type: String })
  @ApiResponse({ status: 403, description: 'Forbidden - locked setting requires SUPER_ADMIN' })
  @ApiResponse({ status: 404, description: 'Global setting not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  @CanUpdate('GlobalSetting')
  async update(
    @Param('id') id: string,
    @Body() request: UpdateGlobalSettingRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<GlobalSettingResponse> {
    // Header takes precedence over the body when both are present; on a
    // `@RequiresIfMatch()` route the param decorator already fired 428 if the
    // header was missing (mirrors ai-model / prompt OCC contract).
    const effectiveRequest: UpdateGlobalSettingRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    const result = await this.globalSettingService.update(id, effectiveRequest);
    return GlobalSettingDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: GlobalSettingResponse,
    method: HttpMethod.DELETE,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Global setting ID', type: String })
  @ApiResponse({ status: 404, description: 'Global setting not found' })
  @CanDelete('GlobalSetting')
  async delete(@Param('id') id: string): Promise<GlobalSettingResponse> {
    // Domain softDelete — never a hard delete.
    const result = await this.globalSettingService.deleteById(id);
    return GlobalSettingDtoMapper.ToResponse(result);
  }

  /**
   * Reveal ONE secret setting's decrypted plaintext.
   *
   * GLOBAL-ADMIN ONLY: the method-level `@Authorize(['manage','all'])`
   * OVERRIDES the class-level `@CanManage('GlobalSetting')` (the
   * `UnifiedAuthGuard` resolves required-permission metadata via
   * `getAllAndOverride([handler, class])`). Only the `system-full-access`
   * policy grants `manage:all`, so tenant admins — who hold `manage:GlobalSetting`
   * but not `manage:all` — get 403. Same posture as the queue/rate-limit admin
   * surfaces.
   *
   * Step-up re-auth: the body carries the caller's current password, verified
   * server-side against the stored bcrypt hash (never logged, never persisted).
   * Never a bulk reveal — single `:id` only. Every call is audit-logged in the
   * service (SysEvent, plaintext excluded).
   */
  @Post(':id/reveal')
  @HttpCode(200)
  @Authorize(['manage', 'all'])
  @ApiOperation({
    summary: 'Reveal a secret setting (global-admin, step-up re-auth, audited)',
    description:
      'Returns the decrypted plaintext of ONE global setting. SUPER_ADMIN only ' +
      '(CASL `manage:all`). Requires step-up re-authentication: the request body ' +
      "must carry the caller's current account password, verified server-side " +
      'against the stored hash. Every reveal is audit-logged; the plaintext is ' +
      'never logged. Never bulk-reveals.',
  })
  @ApiParam({ name: 'id', description: 'Global setting ID', type: String })
  @ApiResponse({ status: 200, description: 'Decrypted secret (transient)', type: RevealGlobalSettingResponse })
  @ApiResponse({ status: 401, description: 'Step-up re-authentication required or password incorrect' })
  @ApiResponse({ status: 403, description: 'Forbidden — reveal is SUPER_ADMIN only' })
  @ApiResponse({ status: 404, description: 'Global setting not found' })
  async reveal(@Param('id') id: string, @Body() request: RevealGlobalSettingRequest): Promise<RevealGlobalSettingResponse> {
    const { entity, plaintext } = await this.globalSettingService.revealSecret(id, request.password);
    return new RevealGlobalSettingResponse({
      id: entity.id,
      key: entity.key,
      value: plaintext,
      revealedAt: new Date().toISOString(),
    });
  }

  /**
   * Rotate ONE secret setting (atomic replace-with-new-value).
   *
   * Gating mirrors `reveal`: method-level `@Authorize(['manage','all'])`
   * OVERRIDES the class `@CanManage('GlobalSetting')` so only SUPER_ADMIN
   * passes (tenant admins 403), plus step-up re-auth (current password in the
   * body, bcrypt-verified in the service — never logged, never persisted).
   *
   * OCC mirrors `update`: rotation is a versioned write, so `If-Match` is
   * REQUIRED (`@RequiresIfMatch()` → 428 when missing) and the header version
   * overrides the body `expectedVersion`; drift → 412. The old secret is
   * invalidated by the same compare-and-set write — no dual-validity window.
   *
   * The response is the MASKED setting (new `version`/ETag via the global
   * `ETagInterceptor`); the new plaintext is NEVER returned. Every rotation is
   * force-audited with the distinct `GLOBAL_SETTING_SECRET_ROTATED` action tag
   * (plaintext excluded). Never bulk — single `:id` only.
   */
  @Post(':id/rotate')
  @HttpCode(200)
  @Authorize(['manage', 'all'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Rotate a secret setting (global-admin, step-up re-auth, OCC, audited)',
    description:
      'Atomically replaces the stored secret value of ONE global setting under ' +
      'optimistic concurrency. SUPER_ADMIN only (CASL `manage:all`). Requires ' +
      "step-up re-authentication (the caller's current password in the body) AND " +
      'the RFC 7232 `If-Match` header carrying the row version (missing → 428, ' +
      'drift → 412). The old value is invalidated by the same versioned write. ' +
      'Every rotation is distinctly audit-logged; neither the old nor the new ' +
      'plaintext is ever logged or returned — the response is the masked setting.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the row version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Global setting ID', type: String })
  @ApiResponse({ status: 200, description: 'Secret rotated — masked setting with the new version', type: GlobalSettingResponse })
  @ApiResponse({ status: 400, description: 'Not a secret setting, or empty replacement value' })
  @ApiResponse({ status: 401, description: 'Step-up re-authentication required or password incorrect' })
  @ApiResponse({ status: 403, description: 'Forbidden — rotation is SUPER_ADMIN only' })
  @ApiResponse({ status: 404, description: 'Global setting not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async rotate(
    @Param('id') id: string,
    @Body() request: RotateGlobalSettingRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<GlobalSettingResponse> {
    // Header takes precedence over the body when both are present (same OCC
    // contract as `update`; `@RequiresIfMatch()` already fired 428 if absent).
    const effectiveRequest: RotateGlobalSettingRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    const result = await this.globalSettingService.rotateSecret(id, effectiveRequest);
    // Masked response — the DTO mapper blanks secret values; plaintext never leaves the reveal endpoint.
    return GlobalSettingDtoMapper.ToResponse(result);
  }
}
