import {
  EffectiveTtsConfigResponse,
  IActiveUserContext,
  ITenantTtsConfigService,
  SetTtsCredentialRequest,
  TenantTtsConfigResponse,
  TtsCredentialResponse,
  TtsPlatformCatalogResponse,
  UpdateTenantTtsConfigRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put, Query } from '@nestjs/common';
import { resolveScopedTenantId } from '../../shared/tenant-scope';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, ExpectedVersion, RequiresIfMatch } from '../../decorators';

/**
 * TenantTtsConfigAdminController — the admin surface for a tenant's
 * TTS spec + BYO provider credentials, mounted at `/admin/tts-config` (global
 * prefix → `/api/v1/admin/tts-config`). Mirrors `PipelinePolicyAdminController`:
 * `@Authorize`, `If-Match` OCC, CLS tenant resolution.
 *
 *  - `GET ''`    → the RESOLVED effective spec (tenant row over the SYSTEM
 *    default, clamped to platform limits). Read-only; consumed by the gateway
 *    resolve-and-inject path.
 *  - `GET 'row'` → ONE raw, editable config row (`version` drives the OCC token;
 *    a `version:0` placeholder when none exists yet).
 *  - `PUT 'row'` → create (`expectedVersion` 0) or CAS-update the row under
 *    `If-Match` (drift → 412, missing → 428).
 *
 * Tenant admins are pinned to their CLS tenant; global-admins (`isSuperAdmin`)
 * act cross-tenant — incl. the SYSTEM-tenant platform default — via `?tenantId=`.
 * Credentials (BYO keys) get their own routes in Phase 6.
 */
@ApiBearerAuth()
@ApiTags('admin-tts')
@Controller('admin/tts-config')
@Authorize()
export class TenantTtsConfigAdminController {
  constructor(
    @Inject(ITenantTtsConfigService) private readonly configService: ITenantTtsConfigService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @Authorize(['read', 'TenantTtsConfig'])
  @ApiOperation({
    summary: 'Resolve the effective TTS spec for a tenant (tenant row over the SYSTEM default, clamped)',
    description:
      'Merges the tenant row over the SYSTEM-tenant platform default and clamps every value to the platform limits. ' +
      'Read-only; this is what the gateway injects into tts per request.',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiResponse({ status: 200, type: EffectiveTtsConfigResponse })
  async getEffective(@Query('tenantId') tenantId?: string): Promise<EffectiveTtsConfigResponse> {
    return this.configService.getEffective(this.resolveTenantId(tenantId));
  }

  @Get('row')
  @Authorize(['read', 'TenantTtsConfig'])
  @ApiOperation({
    summary: 'Get the raw, editable TTS config row for a tenant',
    description:
      'Returns the tenant row, or a `version:0` placeholder (all-inherit) when none exists yet. The `version` drives ' +
      'the `If-Match` OCC token for the matching `PUT` (create with `expectedVersion: 0`).',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: TenantTtsConfigResponse })
  async getRow(@Query('tenantId') tenantId?: string): Promise<TenantTtsConfigResponse> {
    return this.configService.getRow(this.resolveTenantId(tenantId));
  }

  @Put('row')
  @Authorize(['manage', 'TenantTtsConfig'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Create or update the tenant TTS config row under optimistic concurrency',
    description:
      'Upserts the supplied spec fields (omit = unchanged; null/empty = inherit). `If-Match` (RFC 7232) carries the ' +
      'version read from the prior GET — `"0"` creates the row, an existing version CASes against `_version` ' +
      '(drift → 412, missing → 428). Every value is clamped to the platform limits by the resolver.',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"0"` to create).',
    required: true,
    example: '"0"',
  })
  @ApiResponse({ status: 200, type: TenantTtsConfigResponse })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async updateRow(
    @Body() request: UpdateTenantTtsConfigRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('tenantId') tenantId?: string,
  ): Promise<TenantTtsConfigResponse> {
    const dto = { ...request, expectedVersion: expectedFromHeader ?? request.expectedVersion };
    return this.configService.upsertRow(this.resolveTenantId(tenantId), dto);
  }

  @Get('catalog')
  @Authorize(['read', 'TenantTtsConfig'])
  @ApiOperation({
    summary: 'Platform TTS catalog — providers + voices derived from the AiModel registry',
    description:
      'SYSTEM ENABLED TEXT_TO_SPEECH registry rows (code-constant fallback pre-seed). Tenant-agnostic: the catalog is the ' +
      'platform-wide universe voice bindings are validated against — no tenant scoping.',
  })
  @ApiResponse({ status: 200, type: TtsPlatformCatalogResponse })
  async getCatalog(): Promise<TtsPlatformCatalogResponse> {
    return this.configService.getPlatformCatalog();
  }

  @Get('credentials')
  @Authorize(['read', 'TenantTtsConfig'])
  @ApiOperation({ summary: "List a tenant's BYO provider credentials (masked — never the key)" })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: [TtsCredentialResponse] })
  async getCredentials(@Query('tenantId') tenantId?: string): Promise<TtsCredentialResponse[]> {
    return this.configService.getCredentials(this.resolveTenantId(tenantId));
  }

  @Put('credentials/:provider')
  @Authorize(['manage', 'TenantTtsConfig'])
  @ApiOperation({
    summary: 'Set or rotate a tenant BYO provider key (write-only; Vault-encrypted at rest, never returned)',
  })
  @ApiParam({ name: 'provider', enum: ['azure', 'sarvam'] })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: TtsCredentialResponse })
  @ApiResponse({ status: 400, description: 'Unsupported provider, or Vault secrets provider not configured.' })
  async setCredential(
    @Param('provider') provider: string,
    @Body() body: SetTtsCredentialRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<TtsCredentialResponse> {
    return this.configService.setCredential(this.resolveTenantId(tenantId), provider, body);
  }

  @Delete('credentials/:provider')
  @HttpCode(204)
  @Authorize(['manage', 'TenantTtsConfig'])
  @ApiOperation({ summary: 'Remove a tenant BYO provider credential' })
  @ApiParam({ name: 'provider', enum: ['azure', 'sarvam'] })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 204, description: 'Removed.' })
  @ApiResponse({ status: 404, description: 'No credential for this provider.' })
  async removeCredential(@Param('provider') provider: string, @Query('tenantId') tenantId?: string): Promise<void> {
    return this.configService.removeCredential(this.resolveTenantId(tenantId), provider);
  }

  /** Tenant admins → own tenant; global-admins → `?tenantId=` (or CLS tenant). */
  private resolveTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
