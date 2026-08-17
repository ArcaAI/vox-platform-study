import {
  AiProviderConnectionResponse,
  CONNECTION_ENABLED_SEMANTICS,
  IActiveUserContext,
  IProviderConnectionService,
  PROVIDER_SERVICES,
  ProviderService,
  UpsertAiProviderConnectionRequest,
} from '@arcaai/applications';
import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanManage, CanRead, ExpectedVersion, RequiresIfMatch, RequiredScopes } from '../../decorators';
import { resolveScopedTenantId } from '../../shared/tenant-scope';

/** Validate the `:service` path segment against the frozen C5 vocabulary. */
function assertProviderService(value: string): ProviderService {
  if ((PROVIDER_SERVICES as readonly string[]).includes(value)) {
    return value as ProviderService;
  }
  throw new BadRequestException(`Unknown provider service '${value}'. Expected one of: ${PROVIDER_SERVICES.join(', ')}.`);
}

/**
 * ProviderConnectionController — the admin surface for provider connections
 * (WHERE a serving provider lives, HOW to authenticate) on the UNIFIED plane,
 * mounted at `/admin/providers` (global prefix → `/api/v1/admin/providers`).
 *
 * A connection row is keyed by (tenant, SERVICE, provider): `service` is the
 * capability discriminator (`llm` | `stt` | `tts`) carried in the path, and
 * `provider` is capability-scoped (`azure` is Azure OpenAI under `llm`, Azure
 * Speech under `stt`).
 *
 *  - `GET :service`             → every connection row for the scoped tenant (masked).
 *  - `GET :service/:provider`   → ONE row (`version` drives the OCC token; a
 *                                 `version: 0` placeholder when none exists yet).
 *  - `PUT :service/:provider`   → create (`expectedVersion` 0) or CAS-update under
 *                                 `If-Match` (drift → 412, missing → 428).
 *  - `DELETE :service/:provider`→ soft-delete.
 *
 * SECRETS: `apiKey` is write-only. No response from any route on this controller
 * carries the ciphertext — presence is reported as `hasKey`. There is
 * deliberately NO reveal route: provider keys are Configured/None only.
 *
 * GOVERNANCE (enforced in `ProviderConnectionService`, not here, so the rule stays
 * descriptor/data-driven rather than duplicated per surface):
 *   - a TENANT row is permitted only for a provider listed under its service in
 *     `CLOUD_BYO_PROVIDERS` (C5); a self-host engine → `ForbiddenException` (403,
 *     a privilege rule on the caller's own tenant — NOT the 404-over-403
 *     cross-tenant posture);
 *   - a SYSTEM row may be written only by a super admin → 403.
 *
 * Tenant admins are pinned to their CLS tenant by `resolveScopedTenantId`;
 * super admins act cross-tenant — incl. the SYSTEM platform default — via
 * `?tenantId=`. A cross-tenant by-id read returns 404, never 403.
 */
@ApiTags('Admin: Provider Connections')
@ApiBearerAuth()
@RequiredScopes('admin:ai-provider:manage')
@Controller('admin/providers')
export class ProviderConnectionController {
  constructor(
    @Inject(IProviderConnectionService)
    private readonly connectionService: IProviderConnectionService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get(':service')
  @CanRead('GlobalSetting')
  @ApiOperation({ summary: 'List provider connections for one service and the scoped tenant (keys never returned).' })
  @ApiParam({ name: 'service', description: 'Capability the connection serves.', enum: ['llm', 'stt', 'tts'] })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform admins scope with this; tenant admins are pinned.' })
  @ApiResponse({ status: 200, type: [AiProviderConnectionResponse] })
  async list(@Param('service') service: string, @Query('tenantId') tenantId?: string): Promise<AiProviderConnectionResponse[]> {
    return this.connectionService.list(assertProviderService(service), this.resolveTenantId(tenantId));
  }

  @Get(':service/:provider')
  @CanRead('GlobalSetting')
  @ApiOperation({ summary: 'Read one provider connection (key never returned; placeholder when absent).' })
  @ApiParam({ name: 'service', description: 'Capability the connection serves.', enum: ['llm', 'stt', 'tts'] })
  @ApiParam({ name: 'provider', description: 'Capability-scoped provider identifier, e.g. `azure`.' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, type: AiProviderConnectionResponse })
  @ApiResponse({ status: 404, description: 'Not found — including a row owned by another tenant.' })
  async getOne(
    @Param('service') service: string,
    @Param('provider') provider: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<AiProviderConnectionResponse> {
    return this.connectionService.getRow(assertProviderService(service), provider, this.resolveTenantId(tenantId));
  }

  @Put(':service/:provider')
  @CanManage('GlobalSetting')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Create or update one provider connection.',
    description:
      'Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED and the server runs a ' +
      "Compare-And-Set against the row's `_version`. When present the header overrides the body-field " +
      '`expectedVersion`. Version drift → `412`; missing header → `428`. Use `expectedVersion: 0` to create. ' +
      'A supplied `apiKey` is Vault-Transit encrypted and never returned; omitting it leaves the stored key intact. ' +
      `**\`enabled\` is three-state.** ${CONNECTION_ENABLED_SEMANTICS}`,
  })
  @ApiParam({ name: 'service', description: 'Capability the connection serves.', enum: ['llm', 'stt', 'tts'] })
  @ApiParam({ name: 'provider', description: 'Capability-scoped provider identifier, e.g. `azure`.' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, type: AiProviderConnectionResponse })
  @ApiResponse({ status: 403, description: 'Non-listed provider on a tenant row, or a SYSTEM row without super admin.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async upsert(
    @Param('service') service: string,
    @Param('provider') provider: string,
    @Body() request: UpsertAiProviderConnectionRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('tenantId') tenantId?: string,
  ): Promise<AiProviderConnectionResponse> {
    // Header takes precedence over body when both are present. On a
    // `@RequiresIfMatch()` route the param decorator already 428'd if the header
    // was missing, so the `??` fallback only fires for unit tests and off-route
    // service-to-service traffic. The create case travels through the header too:
    // `If-Match: "0"` parses to 0 (create-intent) and the service CAS decides
    // create-vs-412.
    const dto = { ...request, expectedVersion: expectedFromHeader ?? request.expectedVersion };
    return this.connectionService.upsertRow(assertProviderService(service), provider, dto, this.resolveTenantId(tenantId));
  }

  @Delete(':service/:provider')
  @CanManage('GlobalSetting')
  @ApiOperation({
    summary: 'Soft-delete one provider connection.',
    description:
      'Deleting returns this (service, provider) to "no opinion", so the platform-provided credential may serve it ' +
      'again (subject to the platform-default entitlement). To BLOCK the provider instead — including the ' +
      'platform-provided key — keep the row and set `enabled: false`, which is a veto.',
  })
  @ApiParam({ name: 'service', description: 'Capability the connection serves.', enum: ['llm', 'stt', 'tts'] })
  @ApiParam({ name: 'provider', description: 'Capability-scoped provider identifier, e.g. `azure`.' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  @ApiResponse({ status: 403, description: 'Non-listed provider on a tenant row, or a SYSTEM row without super admin.' })
  async remove(@Param('service') service: string, @Param('provider') provider: string, @Query('tenantId') tenantId?: string): Promise<void> {
    return this.connectionService.deleteRow(assertProviderService(service), provider, this.resolveTenantId(tenantId));
  }

  private resolveTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}

/**
 * LEGACY ALIAS — `/admin/ai-providers` (the pre-unification LLM-only surface).
 *
 * Kept for ONE release (C3) so existing clients and the frozen
 * `ai-provider-connections.spec.ts` e2e keep working while the console cuts over
 * to `/admin/providers/llm/*`. Every route hard-pins `service='llm'` and
 * delegates to the same unified `ProviderConnectionService`; there is no
 * behavioural difference from `admin/providers/llm/*`. Delete this controller
 * (and drop it from the module) when the deprecation window closes.
 */
@ApiTags('Admin: AI Provider Connections (legacy alias)')
@ApiBearerAuth()
@RequiredScopes('admin:ai-provider:manage')
@Controller('admin/ai-providers')
export class AiProviderConnectionController {
  private static readonly SERVICE: ProviderService = 'llm';

  constructor(
    @Inject(IProviderConnectionService)
    private readonly connectionService: IProviderConnectionService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @CanRead('GlobalSetting')
  @ApiOperation({ summary: 'DEPRECATED — use `GET admin/providers/llm`. List LLM provider connections (keys never returned).' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform admins scope with this; tenant admins are pinned.' })
  @ApiResponse({ status: 200, type: [AiProviderConnectionResponse] })
  async list(@Query('tenantId') tenantId?: string): Promise<AiProviderConnectionResponse[]> {
    return this.connectionService.list(AiProviderConnectionController.SERVICE, this.resolveTenantId(tenantId));
  }

  @Get(':provider')
  @CanRead('GlobalSetting')
  @ApiOperation({ summary: 'DEPRECATED — use `GET admin/providers/llm/:provider`.' })
  @ApiParam({ name: 'provider', description: 'Serving provider identifier, e.g. `azure`.' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, type: AiProviderConnectionResponse })
  @ApiResponse({ status: 404, description: 'Not found — including a row owned by another tenant.' })
  async getOne(@Param('provider') provider: string, @Query('tenantId') tenantId?: string): Promise<AiProviderConnectionResponse> {
    return this.connectionService.getRow(AiProviderConnectionController.SERVICE, provider, this.resolveTenantId(tenantId));
  }

  @Put(':provider')
  @CanManage('GlobalSetting')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'DEPRECATED — use `PUT admin/providers/llm/:provider`. Create or update one LLM provider connection.',
    description:
      'Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED and the server runs a ' +
      "Compare-And-Set against the row's `_version`. When present the header overrides the body-field " +
      '`expectedVersion`. Version drift → `412`; missing header → `428`. Use `expectedVersion: 0` to create.',
  })
  @ApiParam({ name: 'provider', description: 'Serving provider identifier, e.g. `azure`.' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, type: AiProviderConnectionResponse })
  @ApiResponse({ status: 403, description: 'Self-hosted provider on a tenant row, or a SYSTEM row without super admin.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async upsert(
    @Param('provider') provider: string,
    @Body() request: UpsertAiProviderConnectionRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('tenantId') tenantId?: string,
  ): Promise<AiProviderConnectionResponse> {
    const dto = { ...request, expectedVersion: expectedFromHeader ?? request.expectedVersion };
    return this.connectionService.upsertRow(AiProviderConnectionController.SERVICE, provider, dto, this.resolveTenantId(tenantId));
  }

  @Delete(':provider')
  @CanManage('GlobalSetting')
  @ApiOperation({ summary: 'DEPRECATED — use `DELETE admin/providers/llm/:provider`. Soft-delete one LLM provider connection.' })
  @ApiParam({ name: 'provider', description: 'Serving provider identifier, e.g. `azure`.' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  @ApiResponse({ status: 403, description: 'Self-hosted provider on a tenant row, or a SYSTEM row without super admin.' })
  async remove(@Param('provider') provider: string, @Query('tenantId') tenantId?: string): Promise<void> {
    return this.connectionService.deleteRow(AiProviderConnectionController.SERVICE, provider, this.resolveTenantId(tenantId));
  }

  private resolveTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
