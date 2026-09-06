import {
  AiProviderConnectionResponse,
  CONNECTION_ENABLED_SEMANTICS,
  DeclareConnectionModelsRequest,
  IActiveUserContext,
  IProviderConnectionService,
  PROVIDER_SERVICES,
  ProviderConnectionProbe,
  ProviderService,
  TestProviderConnectionRequest,
  TestProviderConnectionResponse,
  UpsertAiProviderConnectionRequest,
} from '@arcaai/applications';
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanManage, CanRead, ExpectedVersion, RequiresIfMatch, ForbidApiKey, RequiredSvcScopes } from '../../decorators';
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
 * capability discriminator (`PROVIDER_SERVICES` — the three inference
 * capabilities plus the `embeddings`/`rerank`/`vector` integrations) carried in the path, and
 * `provider` is capability-scoped (`azure` is Azure OpenAI under `llm`, Azure
 * Speech under `stt`).
 *
 *  - `GET :service`             → every connection row for the scoped tenant (masked).
 *  - `GET :service/:provider`   → ONE row (`version` drives the OCC token; a
 *                                 `version: 0` placeholder when none exists yet).
 *  - `PUT :service/:provider`   → create (`expectedVersion` 0) or CAS-update under
 *                                 `If-Match` (drift → 412, missing → 428).
 *  - `PUT :service/:provider/models` → declare the models this connection serves
 *                                 (TASK-890 §3.7a): each becomes a tenant-owned
 *                                 registry row; the list is a full replacement.
 *  - `DELETE :service/:provider`→ soft-delete (its declared models go with it).
 *  - `POST :service/:provider/test` → ephemeral "Test connection" probe (TASK-862):
 *                                 never persisted, no OCC; omitted fields fall
 *                                 back to the stored row (tenant → SYSTEM).
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
@ApiTags('admin-provider-connections')
@ApiBearerAuth()
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:ai-provider:manage')
@Controller('admin/providers')
export class ProviderConnectionController {
  constructor(
    @Inject(IProviderConnectionService)
    private readonly connectionService: IProviderConnectionService,
    private readonly probe: ProviderConnectionProbe,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get(':service')
  @CanRead('GlobalSetting')
  @ApiOperation({ summary: 'List provider connections for one service and the scoped tenant (keys never returned).' })
  @ApiParam({ name: 'service', description: 'Capability the connection serves.', enum: PROVIDER_SERVICES })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform admins scope with this; tenant admins are pinned.' })
  @ApiResponse({ status: 200, type: [AiProviderConnectionResponse] })
  async list(@Param('service') service: string, @Query('tenantId') tenantId?: string): Promise<AiProviderConnectionResponse[]> {
    return this.connectionService.list(assertProviderService(service), this.resolveTenantId(tenantId));
  }

  @Get(':service/:provider')
  @CanRead('GlobalSetting')
  @ApiOperation({ summary: 'Read one provider connection (key never returned; placeholder when absent).' })
  @ApiParam({ name: 'service', description: 'Capability the connection serves.', enum: PROVIDER_SERVICES })
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
  @ApiParam({ name: 'service', description: 'Capability the connection serves.', enum: PROVIDER_SERVICES })
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

  @Put(':service/:provider/models')
  @CanManage('GlobalSetting')
  @ApiOperation({
    summary: "Declare the models this tenant's connection serves.",
    description:
      'Bring provider AND model together (TASK-890): the connection says WHERE the vendor account is, this says WHICH ' +
      'models it serves. Each entry becomes a TENANT-OWNED registry row visible only in this tenant\u2019s catalogue, ' +
      'bindable by an agent. The body is the WHOLE list — an entry that leaves it is soft-deleted (an agent still bound ' +
      'to it keeps its reference and fails its next publish, observably). Slugs are SERVER-generated and stable; a ' +
      'generated slug that would shadow a platform model is refused with `409 BYO_SLUG_SHADOWS_PLATFORM`, which names ' +
      'the platform row and a `byo-` prefixed `suggestedSlug` to re-send. No `If-Match`: this writes registry rows, not ' +
      'the connection row, so it carries no version of its own. Platform models are declared in `/admin/ai-models`.',
  })
  @ApiParam({ name: 'service', description: 'Capability the connection serves.', enum: PROVIDER_SERVICES })
  @ApiParam({ name: 'provider', description: 'Capability-scoped provider identifier, e.g. `azure`.' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, type: AiProviderConnectionResponse, description: 'The connection, with its declared `models[]`.' })
  @ApiResponse({ status: 400, description: 'Unknown service, a task type the capability does not serve, or a duplicated model id.' })
  @ApiResponse({ status: 403, description: 'A SYSTEM connection, or a provider this tenant may not hold a row for.' })
  @ApiResponse({ status: 404, description: 'No connection row yet — save the credential before declaring its models.' })
  @ApiResponse({ status: 409, description: 'A generated slug would shadow a platform model (`BYO_SLUG_SHADOWS_PLATFORM`).' })
  async declareModels(
    @Param('service') service: string,
    @Param('provider') provider: string,
    @Body() request: DeclareConnectionModelsRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<AiProviderConnectionResponse> {
    return this.connectionService.declareModels(assertProviderService(service), provider, request, this.resolveTenantId(tenantId));
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
  @ApiParam({ name: 'service', description: 'Capability the connection serves.', enum: PROVIDER_SERVICES })
  @ApiParam({ name: 'provider', description: 'Capability-scoped provider identifier, e.g. `azure`.' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  @ApiResponse({ status: 403, description: 'Non-listed provider on a tenant row, or a SYSTEM row without super admin.' })
  async remove(@Param('service') service: string, @Param('provider') provider: string, @Query('tenantId') tenantId?: string): Promise<void> {
    return this.connectionService.deleteRow(assertProviderService(service), provider, this.resolveTenantId(tenantId));
  }

  @Post(':service/:provider/test')
  @HttpCode(200)
  @CanManage('GlobalSetting')
  @ApiOperation({
    summary: 'Test a provider connection against the live vendor (ephemeral — never persisted).',
    description:
      'Probes the credential/endpoint BEFORE (or independent of) saving it. Every body field is optional: an omitted field ' +
      'falls back to the STORED row (the tenant row, else the SYSTEM platform default), so a saved write-only key can be ' +
      're-tested without re-entering it. A real auth-only call where the vendor exposes one (`probe: "auth"`), a ' +
      'reachability smoke test otherwise (`probe: "reachability"`). No Vault write, no OCC, the key is never logged. ' +
      'Tenant-supplied URLs must be https and public.',
  })
  @ApiParam({ name: 'service', description: 'Capability the connection serves.', enum: PROVIDER_SERVICES })
  @ApiParam({ name: 'provider', description: 'Capability-scoped provider identifier, e.g. `azure`.' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, type: TestProviderConnectionResponse })
  @ApiResponse({ status: 400, description: 'Unknown service, missing endpoint/region for the probe, or a URL that failed validation.' })
  async testConnection(
    @Param('service') service: string,
    @Param('provider') provider: string,
    @Body() body: TestProviderConnectionRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<TestProviderConnectionResponse> {
    return this.probe.test(assertProviderService(service), provider, this.resolveTenantId(tenantId), body);
  }

  private resolveTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
