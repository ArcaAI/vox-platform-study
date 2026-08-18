import {
  EffectiveSttConfigResponse,
  IActiveUserContext,
  ITenantSttConfigService,
  PipelineResponse,
  SetSttCredentialRequest,
  SetSttFallbackRequest,
  SttCredentialResponse,
  TenantSttConfigResponse,
  TestSttCredentialRequest,
  TestSttCredentialResponse,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { resolveScopedTenantId } from '../../shared/tenant-scope';
import { Authorize, ExpectedVersion, RequiresIfMatch, ForbidApiKey } from '../../decorators';

/**
 * TenantSttConfigAdminController — the admin surface for a tenant's STT fallback
 * spec + BYO provider credentials, mounted at `/admin/stt-config` (global prefix
 * → `/api/v1/admin/stt-config`). Mirrors `TenantTtsConfigAdminController`:
 * `@Authorize`, `If-Match` OCC, CLS tenant resolution.
 *
 *  - `GET ''`                   → the RESOLVED effective fallback spec (tenant
 *    row over the SYSTEM default). Read-only; what the gateway reads on the
 *    session-create path.
 *  - `GET 'row'`                → ONE raw, editable config row (`version` drives
 *    the OCC token; a `version:0` placeholder when none exists yet).
 *  - `PUT 'row'`                → create (`expectedVersion` 0) or CAS-update the
 *    fallback pointer + auto-switch knobs under `If-Match` (missing → 428, drift
 *    → 412).
 *  - `GET 'fallback-candidates'`→ the enabled, cloud-engine-backed pipelines the
 *    tenant may target (the picker's valid options).
 *  - `GET/PUT/DELETE 'credentials/:provider'` → masked BYO credentials; the key
 *    is write-only (Vault-encrypted, never returned). PUT is OCC-guarded too
 * (credential-OCC divergence).
 *  - `POST 'credentials/:provider/test'` → ephemeral "Test connection" probe of
 *    an apiKey/region/endpoint BEFORE it is saved. Never persisted, no OCC.
 *
 * Tenant admins are pinned to their CLS tenant; super-admins (`isSuperAdmin`)
 * act cross-tenant — incl. the SYSTEM-tenant platform default — via `?tenantId=`.
 * A foreign `?tenantId=` on a scoped read is rejected by `resolveScopedTenantId`.
 * The controller holds NO business logic: it resolves the target tenant and
 * delegates to `ITenantSttConfigService`.
 */
@ApiBearerAuth()
@ApiTags('admin-stt')
@ForbidApiKey()
@Controller('admin/stt-config')
@Authorize()
export class TenantSttConfigAdminController {
  constructor(
    @Inject(ITenantSttConfigService) private readonly configService: ITenantSttConfigService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @Authorize(['read', 'TenantSttConfig'])
  @ApiOperation({
    summary: 'Resolve the effective STT fallback spec for a tenant (tenant row over the SYSTEM default)',
    description:
      'Merges the tenant row over the SYSTEM-tenant platform default. Read-only; this is what the gateway reads on the session-create path.',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiResponse({ status: 200, type: EffectiveSttConfigResponse })
  async getEffective(@Query('tenantId') tenantId?: string): Promise<EffectiveSttConfigResponse> {
    return this.configService.getEffective(this.resolveTenantId(tenantId));
  }

  @Get('row')
  @Authorize(['read', 'TenantSttConfig'])
  @ApiOperation({
    summary: 'Get the raw, editable STT config row for a tenant',
    description:
      'Returns the tenant row, or a `version:0` placeholder (all-inherit) when none exists yet. The `version` drives the `If-Match` OCC token for the matching `PUT` (create with `expectedVersion: 0`).',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: TenantSttConfigResponse })
  async getRow(@Query('tenantId') tenantId?: string): Promise<TenantSttConfigResponse> {
    return this.configService.getRow(this.resolveTenantId(tenantId));
  }

  @Put('row')
  @Authorize(['manage', 'TenantSttConfig'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Create or update the tenant STT fallback row under optimistic concurrency',
    description:
      'Upserts the fallback pipeline pointer + auto-switch knobs (omit = unchanged; `fallbackPipelineId: null` clears it). `If-Match` (RFC 7232) carries the version read from the prior GET — `"0"` creates the row, an existing version CASes against `_version` (drift → 412, missing → 428). The fallback target is validated (tenant-visible, ENABLED, cloud-engine-backed).',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"0"` to create).',
    required: true,
    example: '"0"',
  })
  @ApiResponse({ status: 200, type: TenantSttConfigResponse })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async updateRow(
    @Body() request: SetSttFallbackRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('tenantId') tenantId?: string,
  ): Promise<TenantSttConfigResponse> {
    const dto = { ...request, expectedVersion: expectedFromHeader ?? request.expectedVersion };
    return this.configService.setFallbackPipeline(this.resolveTenantId(tenantId), dto);
  }

  @Get('fallback-candidates')
  @Authorize(['read', 'TenantSttConfig'])
  @ApiOperation({
    summary: 'List the enabled, cloud-engine-backed pipelines a tenant may set as its fallback',
    description: 'The valid targets for the fallback pointer — the picker offers exactly these, so the PUT never rejects a selection.',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: [PipelineResponse] })
  async getFallbackCandidates(@Query('tenantId') tenantId?: string): Promise<PipelineResponse[]> {
    return this.configService.getFallbackCandidates(this.resolveTenantId(tenantId));
  }

  @Get('credentials')
  @Authorize(['read', 'TenantSttConfig'])
  @ApiOperation({ summary: "List a tenant's BYO provider credentials (masked — never the key)" })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: [SttCredentialResponse] })
  async getCredentials(@Query('tenantId') tenantId?: string): Promise<SttCredentialResponse[]> {
    return this.configService.getCredentials(this.resolveTenantId(tenantId));
  }

  @Put('credentials/:provider')
  @Authorize(['manage', 'TenantSttConfig'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Set or rotate a tenant BYO provider key (write-only; Vault-encrypted at rest, never returned)',
    description:
      '`If-Match` (RFC 7232) carries the credential version — `"0"` creates, an existing version CASes against `_version` (drift → 412, missing → 428).',
  })
  @ApiParam({ name: 'provider', enum: ['azure-speech', 'sarvam', 'openai'] })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the credential version the client read (e.g. `"0"` to create).',
    required: true,
    example: '"0"',
  })
  @ApiResponse({ status: 200, type: SttCredentialResponse })
  @ApiResponse({ status: 400, description: 'Unsupported provider, or Vault secrets provider not configured.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async setCredential(
    @Param('provider') provider: string,
    @Body() body: SetSttCredentialRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('tenantId') tenantId?: string,
  ): Promise<SttCredentialResponse> {
    const dto = { ...body, expectedVersion: expectedFromHeader ?? body.expectedVersion };
    return this.configService.setCredential(this.resolveTenantId(tenantId), provider, dto);
  }

  @Delete('credentials/:provider')
  @HttpCode(204)
  @Authorize(['manage', 'TenantSttConfig'])
  @ApiOperation({ summary: 'Remove a tenant BYO provider credential' })
  @ApiParam({ name: 'provider', enum: ['azure-speech', 'sarvam', 'openai'] })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 204, description: 'Removed.' })
  @ApiResponse({ status: 404, description: 'No credential for this provider.' })
  async removeCredential(@Param('provider') provider: string, @Query('tenantId') tenantId?: string): Promise<void> {
    return this.configService.removeCredential(this.resolveTenantId(tenantId), provider);
  }

  @Post('credentials/:provider/test')
  @Authorize(['manage', 'TenantSttConfig'])
  @ApiOperation({
    summary: 'Test an apiKey/region/endpoint combination against the live provider BEFORE saving it',
    description:
      'Ephemeral probe — never persisted, no Vault write, no OCC. Lets a tenant admin validate a key before (or independent of) saving it, ' +
      'since the saved key is write-only and never returned for re-testing.',
  })
  @ApiParam({ name: 'provider', enum: ['azure-speech', 'sarvam', 'openai'] })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: TestSttCredentialResponse })
  @ApiResponse({ status: 400, description: 'Unsupported provider, or the supplied endpoint failed URL/SSRF validation.' })
  async testCredential(
    @Param('provider') provider: string,
    @Body() body: TestSttCredentialRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<TestSttCredentialResponse> {
    return this.configService.testCredential(this.resolveTenantId(tenantId), provider, body);
  }

  /** Tenant admins → own tenant; super-admins → `?tenantId=` (or CLS tenant). */
  private resolveTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
