import {
  GlobalSettingDtoMapper,
  GlobalSettingResponse,
  PaginatedGlobalSettingResponse,
  CreateGlobalSettingRequest,
  UpdateGlobalSettingRequest,
  PaginatedQuery,
  IActiveUserContext,
  IGlobalSettingService,
  HttpMethod,
} from '@arcaai/applications';
import { Body, Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { ApiEndpoint, CanCreate, CanManage, CanRead, CanUpdate, CanDelete, ExpectedVersion, RequiresIfMatch } from '../../decorators';

/**
 * TASK-390 #24 (ST1) — Global-settings admin CRUD.
 *
 * Thin delegation surface over the already-existing `GlobalSettingService`
 * (create / fetchAll / fetchAllByTenantId / fetchById / update / softDelete),
 * mirroring `ai-model-admin.controller.ts` (OCC) + `api-key.controller.ts`
 * (entity→DTO mapping). No schema change — the `GlobalSetting` model + domain
 * + service + SDK hook (`useGlobalSettings`) already exist; this only wires the
 * HTTP surface the SDK's `GLOBAL_SETTINGS_ENDPOINTS` targets.
 *
 * Mount path is `admin/settings` to match the existing, tested SDK contract
 * (the §3a review labels the item `admin/global-settings`; see the TASK-390
 * README §3.3 for the naming reconciliation FLAG).
 *
 * Authorization: class-level `manage:GlobalSetting` (super-admin via
 * `manage:all`; tenant admins via the seeded `tenant-full-access` /
 * `global-settings-manage` policies, tenant-scoped). GET routes relax to
 * `read:GlobalSetting`. OCC on PATCH via the `If-Match` header (the global
 * `ETagInterceptor` emits `ETag: "<version>"` on the single-object GET).
 * `locked` platform-owned rows stay super-admin-only (enforced in the service).
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
  @CanRead('GlobalSetting')
  async fetchAll(@Query() queryParams: PaginatedQuery): Promise<PaginatedGlobalSettingResponse> {
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
      'header is `428 Precondition Required`. `locked` rows are super-admin-only.',
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
}
