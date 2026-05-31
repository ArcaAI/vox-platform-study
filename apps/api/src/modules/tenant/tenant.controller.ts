import {
  ITenantService,
  PaginatedQuery,
  TenantResponse,
  CreateTenantRequest,
  PaginatedTenantResponse,
  UpdateTenantRequest,
  TenantDtoMapper,
  HttpMethod,
  PaginatedTenantConfigResponse,
  GlobalSettingDtoMapper,
  UpdateTenantConfigRequest,
  IActiveUserContext,
  isSuperAdmin,
} from '@arcaai/applications';
import { Controller, Body, Param, Get, Inject, Query, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { ApiEndpoint, CanManage } from '../../decorators';
// TASK-302 Stream D Phase E.1 — `@RequiresIfMatch()` route marker +
// `@ExpectedVersion()` param decorator. The route guard fires 428 when
// the header is missing; the param decorator returns the parsed version
// when present (or `undefined` when this route is NOT marked, leaving
// the body-field as the service's source of truth).
import { RequiresIfMatch, ExpectedVersion } from '../../decorators';
import { TenantUsageResponse } from './dto';

@ApiBearerAuth()
@ApiTags('admin-tenants')
@Controller('admin/tenants')
@CanManage('Tenant')
export class TenantController {
  constructor(
    @Inject(ITenantService)
    private readonly tenantService: ITenantService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  /**
   * TASK-307 W5.5 (AC-19, audit D-5): the class-level `@CanManage('Tenant')`
   * authorises any caller with `manage:Tenant` to reach the per-row routes,
   * but the underlying CASL policy is `tenantId: ${user.tenantId}`. The
   * `:id` path param breaks that condition silently — so each per-row
   * handler must inline-assert the tenant scope itself. SUPER_ADMIN
   * bypasses (cross-tenant ops are an operator's job).
   */
  private assertTenantInScope(targetTenantId: string): void {
    const user = this.cls.get('user');
    if (isSuperAdmin(user)) return;
    if (!user?.tenantId || user.tenantId !== targetTenantId) {
      throw new ForbiddenException('You do not have access to this tenant');
    }
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    method: HttpMethod.POST,
  })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
  async create(@Body() request: CreateTenantRequest): Promise<TenantResponse> {
    const result = await this.tenantService.create(request);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    multi: true,
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  async fetchAll(@Query() queryParams: PaginatedQuery): Promise<PaginatedTenantResponse> {
    const result = await this.tenantService.fetchAll({
      ...queryParams,
    });
    return TenantDtoMapper.ToPaginatedResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    path: 'user/:userId',
    multi: true,
    by: ['createdByUserId'],
  })
  @ApiParam({ name: 'userId', description: 'User ID', type: String })
  async fetchByUserId(@Param('userId') userId: string, @Query() queryParams: PaginatedQuery): Promise<PaginatedTenantResponse> {
    const result = await this.tenantService.fetchAllCreatedByUser({
      ...queryParams,
      userId,
    });
    return TenantDtoMapper.ToPaginatedResponse(result);
  }

  @Get(':id/usage')
  @ApiOperation({ summary: 'Get tenant usage statistics' })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 200, description: 'Tenant usage statistics', type: TenantUsageResponse })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async getUsage(@Param('id') id: string): Promise<TenantUsageResponse> {
    this.assertTenantInScope(id);
    return this.tenantService.getUsageStats(id);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    path: '/:id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async fetchById(@Param('id') id: string): Promise<TenantResponse> {
    const result = await this.tenantService.fetchById(id);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    path: 'code-name/:code-name',
    by: ['code-name'],
  })
  @ApiParam({ name: 'code-name', description: 'Tenant code name', type: String })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async fetchByCodeName(@Param('code-name') codeName: string): Promise<TenantResponse> {
    const result = await this.tenantService.fetchByCodeName(codeName);
    // Guard runs AFTER the lookup because code-name is not the same as the
    // tenant's UUID — we need the loaded row's `id` to compare against the
    // caller's tenant.
    this.assertTenantInScope(result.id);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update tenant',
    description:
      'Updates one tenant row. Optimistic concurrency is enforced (TASK-302 Stream D Phase E.1): ' +
      'the `If-Match` header (RFC 7232) is REQUIRED, and the server runs a Compare-And-Set ' +
      "against the row's `_version`. When the header is present, its value overrides the " +
      'body-field `expectedVersion`. On version drift the response is `412 Precondition Failed`; ' +
      'missing header is `428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description:
      'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`). ' +
      "The server CAS'es against this value; if `_version` has drifted, a `412 " +
      'Precondition Failed` is returned with the current version in the response body.',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateTenantRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<TenantResponse> {
    this.assertTenantInScope(id);
    // TASK-302 Stream D Phase E.1 — header takes precedence over body
    // when both are present. On a `@RequiresIfMatch()` route, the param
    // decorator already fired 428 if the header would have been
    // undefined, so the fallback below is only reachable in tests /
    // off-route service-to-service traffic.
    const effectiveRequest: UpdateTenantRequest = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    const result = await this.tenantService.update(id, effectiveRequest);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    method: HttpMethod.DELETE,
    path: '/:id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async delete(@Param('id') id: string): Promise<TenantResponse> {
    this.assertTenantInScope(id);
    const result = await this.tenantService.deleteById(id);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: PaginatedTenantConfigResponse,
    path: 'configs/:identifier',
    by: ['identifier'],
    multi: true,
  })
  @ApiParam({ name: 'identifier', description: 'Tenant ID or code name', type: String })
  async fetchTenantConfigs(@Param('identifier') identifier: string, @Query() queryParams: PaginatedQuery): Promise<PaginatedTenantConfigResponse> {
    const result = await this.tenantService.fetchTenantConfigs({
      ...queryParams,
      tenantId: identifier,
      codeName: identifier,
    });
    return GlobalSettingDtoMapper.ToPaginatedResponse(result) as PaginatedTenantConfigResponse;
  }

  @ApiEndpoint({
    returnedModel: PaginatedTenantConfigResponse,
    method: HttpMethod.PATCH,
    path: '/configs/:identifier',
    by: ['identifier'],
  })
  @ApiParam({ name: 'identifier', description: 'Tenant ID or code name', type: String })
  @ApiResponse({ status: 400, description: 'Bad request - invalid config data' })
  async updateTenantConfigs(
    @Param('identifier') identifier: string,
    @Body() configs: UpdateTenantConfigRequest[],
  ): Promise<PaginatedTenantConfigResponse> {
    const result = await this.tenantService.updateTenantConfigs(identifier, configs);
    return GlobalSettingDtoMapper.ToPaginatedResponse(result) as PaginatedTenantConfigResponse;
  }
}
