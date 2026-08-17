import { ITenantFrontendConfigService, TenantFrontendConfigResponse, UpsertTenantFrontendConfigRequest } from '@arcaai/applications';
import { Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanAny, ExpectedVersion, RequiredScopes } from '../../decorators';

/**
 * Admin API for the per-tenant FRONTEND audio-pipeline defaults.
 *
 * A single row per tenant holds the client-side capture defaults applied to
 * every user in that tenant (ASR model + feature switches + a typed advanced
 * `configJson`). Tenant scoping mirrors the DNA admin surface:
 * a super admin (SUPER_ADMIN) may target a tenant via
 * `?tenantId=`; a tenant admin is pinned to their CLS tenant and any supplied
 * `tenantId` is ignored by the service.
 *
 * `@CanAny(['manage','Tenant'],['update','Tenant'])` gates the surface:
 * the `tenant-full-access` policy grants tenant admins
 * tenant-scoped `update:Tenant` (not `manage:Tenant`), which now suffices to
 * reach this config surface; SUPER_ADMIN passes via `manage:all`. Matches
 * `TenantStorageConfigAdminController`.
 */
@ApiBearerAuth()
@ApiTags('admin-frontend-pipeline-config')
@RequiredScopes('admin:tenant-frontend-config:manage')
@Controller('admin/tenant-frontend-config')
@CanAny(['manage', 'Tenant'], ['update', 'Tenant'])
export class TenantFrontendConfigAdminController {
  constructor(
    @Inject(ITenantFrontendConfigService)
    private readonly frontendConfigService: ITenantFrontendConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Get the tenant's frontend pipeline config (null when not yet configured)" })
  @ApiQuery({ name: 'tenantId', required: false, type: String, description: 'Super-admin only: target a tenant. Ignored for tenant admins.' })
  @ApiResponse({ status: 200, description: 'Frontend pipeline config, or null when none is set' })
  async get(@Query('tenantId') tenantId?: string): Promise<TenantFrontendConfigResponse | null> {
    return this.frontendConfigService.getByTenant(tenantId);
  }

  @Put()
  @ApiOperation({
    summary: 'Create or update the tenant frontend pipeline config',
    description:
      'Create-or-update (one row per tenant). Optimistic concurrency applies on UPDATE only: ' +
      'supply the row version you last read via the `If-Match` header (RFC 7232) or the body ' +
      '`expectedVersion`. The header wins when both are present. First-time creation needs no ' +
      'version. On drift the response is `412 Precondition Failed`. ' +
      'The body may also carry `transcriptionMode` (LOCAL|BACKEND), `transcriptionModeLocked`, ' +
      'and `captureMode` (RAW_AND_PROCESSED|RAW_ONLY|PROCESSED_ONLY|NONE; null clears the override).',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the row version the client read (e.g. `"3"`). Required on update, omitted on first create.',
    required: false,
    example: '"3"',
  })
  @ApiQuery({ name: 'tenantId', required: false, type: String, description: 'Super-admin only: target a tenant. Ignored for tenant admins.' })
  @ApiResponse({ status: 200, description: 'Stored frontend pipeline config' })
  @ApiResponse({ status: 400, description: 'Bad request — expectedVersion required to update an existing config' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  async upsert(
    @Body() request: UpsertTenantFrontendConfigRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('tenantId') tenantId?: string,
  ): Promise<TenantFrontendConfigResponse> {
    // If-Match (when present) overrides the body `expectedVersion`. The route is
    // intentionally NOT `@RequiresIfMatch()` so a first-time create can omit it.
    const effectiveRequest: UpsertTenantFrontendConfigRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.frontendConfigService.upsert(effectiveRequest, tenantId);
  }
}
