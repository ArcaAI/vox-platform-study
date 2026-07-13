import {
  CreateTenantIdpConfigRequest,
  DirectorySyncService,
  IActiveUserContext,
  ITenantIdpConfigService,
  SetDirectoryCredentialsRequest,
  SyncDirectoryUsersResponse,
  TenantIdpConfigResponse,
  TestConnectionResponse,
  UpdateTenantIdpConfigRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, ExpectedVersion, RequiresIfMatch } from '../../decorators';
import { resolveScopedTenantId } from '../../shared/tenant-scope';

/**
 * TenantIdpConfigAdminController (TASK-498) — the admin surface for a
 * tenant's external OIDC identity provider config, mounted at
 * `/admin/tenant-idp-config` (global prefix → `/api/v1/admin/tenant-idp-config`).
 * Mirrors `TenantTtsConfigAdminController`: `@Authorize`, `If-Match` OCC, CLS
 * tenant resolution, 404-over-403 tenant scoping.
 */
@ApiBearerAuth()
@ApiTags('admin-tenant-idp-config')
@Controller('admin/tenant-idp-config')
@Authorize()
export class TenantIdpConfigAdminController {
  constructor(
    @Inject(ITenantIdpConfigService) private readonly configService: ITenantIdpConfigService,
    private readonly directorySyncService: DirectorySyncService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @Authorize(['read', 'TenantIdentityProvider'])
  @ApiOperation({ summary: "List a tenant's configured external identity providers" })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: [TenantIdpConfigResponse] })
  async list(@Query('tenantId') tenantId?: string): Promise<TenantIdpConfigResponse[]> {
    return this.configService.list(this.resolveTenantId(tenantId));
  }

  @Get(':id')
  @Authorize(['read', 'TenantIdentityProvider'])
  @ApiOperation({ summary: 'Get one identity provider config' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: TenantIdpConfigResponse })
  @ApiResponse({ status: 404 })
  async getById(@Param('id') id: string, @Query('tenantId') tenantId?: string): Promise<TenantIdpConfigResponse> {
    return this.configService.getById(this.resolveTenantId(tenantId), id);
  }

  @Post()
  @Authorize(['manage', 'TenantIdentityProvider'])
  @ApiOperation({
    summary: 'Configure a new external OIDC identity provider (starts DRAFT — D7, no self-lockout)',
    description:
      'The client secret is Vault-sealed and never echoed back. The row must pass "Test connection" before it can be used at /auth/sso/start.',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 201, type: TenantIdpConfigResponse })
  @ApiResponse({ status: 400, description: 'Vault secrets provider not configured' })
  @HttpCode(201)
  async create(@Body() request: CreateTenantIdpConfigRequest, @Query('tenantId') tenantId?: string): Promise<TenantIdpConfigResponse> {
    return this.configService.create(this.resolveTenantId(tenantId), request);
  }

  @Put(':id')
  @Authorize(['manage', 'TenantIdentityProvider'])
  @RequiresIfMatch()
  @ApiOperation({ summary: 'Update an identity provider config under optimistic concurrency' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: TenantIdpConfigResponse })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateTenantIdpConfigRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('tenantId') tenantId?: string,
  ): Promise<TenantIdpConfigResponse> {
    const dto = { ...request, expectedVersion: expectedFromHeader ?? request.expectedVersion };
    return this.configService.update(this.resolveTenantId(tenantId), id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Authorize(['manage', 'TenantIdentityProvider'])
  @ApiOperation({ summary: 'Remove an identity provider config' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 204 })
  async remove(@Param('id') id: string, @Query('tenantId') tenantId?: string): Promise<void> {
    return this.configService.remove(this.resolveTenantId(tenantId), id);
  }

  @Post(':id/test')
  @Authorize(['manage', 'TenantIdentityProvider'])
  @ApiOperation({
    summary: 'Test connection — OIDC discovery + client construction (D7)',
    description: 'A successful probe flips the row DRAFT → ENABLED. Never drives a full browser login (no user is present at config time).',
  })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: TestConnectionResponse })
  async testConnection(@Param('id') id: string, @Query('tenantId') tenantId?: string): Promise<TestConnectionResponse> {
    return this.configService.testConnection(this.resolveTenantId(tenantId), id);
  }

  @Put(':id/directory-credentials')
  @Authorize(['manage', 'TenantIdentityProvider'])
  @ApiOperation({
    summary: 'Seal a directory-API credential bundle for admin-triggered sync (P3)',
    description:
      'Vault-seals the credential bundle into directoryCredentialsRef. Shape matches config.directoryProvider ' +
      '(ms-graph: {azureTenantId, clientId, clientSecret}; google-directory: {serviceAccountEmail, privateKey, ' +
      'delegatedAdminEmail, customerId?}). Write-only — never echoed back. No If-Match (a narrow secret rotation, ' +
      "same posture as the client secret's own rotation on PUT :id).",
  })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: TenantIdpConfigResponse })
  @ApiResponse({ status: 400, description: 'Vault secrets provider not configured' })
  async setDirectoryCredentials(
    @Param('id') id: string,
    @Body() request: SetDirectoryCredentialsRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<TenantIdpConfigResponse> {
    return this.configService.setDirectoryCredentials(this.resolveTenantId(tenantId), id, request);
  }

  @Post(':id/sync')
  @HttpCode(202)
  @Authorize(['manage', 'TenantIdentityProvider'])
  @ApiOperation({
    summary: "Bulk-pull the provider's directory (MS Graph / Google) and pre-provision users (P3)",
    description:
      'Admin-triggered, async. Idempotent (safe to re-run) — upserts are keyed on (providerId, subject); ' +
      'a directory user with an existing FederatedIdentity link is a no-op. Requires config.directoryProvider ' +
      'and a sealed directoryCredentialsRef to already be set on this provider. Poll progress/result via ' +
      'GET /admin/queues/SyncTenantDirectoryUsers/jobs/:jobId.',
  })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 202, type: SyncDirectoryUsersResponse })
  @ApiResponse({ status: 400, description: 'No directoryProvider configured, or no directory credentials sealed.' })
  async syncDirectory(@Param('id') id: string, @Query('tenantId') tenantId?: string): Promise<SyncDirectoryUsersResponse> {
    return this.directorySyncService.enqueueSync(this.resolveTenantId(tenantId), id);
  }

  /** Tenant admins → own tenant; global-admins → `?tenantId=` (or CLS tenant). */
  private resolveTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
