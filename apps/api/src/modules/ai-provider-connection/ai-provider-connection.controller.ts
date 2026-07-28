import {
  AiProviderConnectionResponse,
  IActiveUserContext,
  IAiProviderConnectionService,
  UpsertAiProviderConnectionRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanManage, CanRead, ExpectedVersion, RequiresIfMatch } from '../../decorators';
import { resolveScopedTenantId } from '../../shared/tenant-scope';

/**
 * AiProviderConnectionController — the admin surface for provider
 * connections (WHERE a serving provider lives, HOW to authenticate), mounted at
 * `/admin/ai-providers` (global prefix → `/api/v1/admin/ai-providers`).
 *
 *  - `GET ''`            → every connection row for the scoped tenant (masked).
 *  - `GET ':provider'`   → ONE row (`version` drives the OCC token; a
 *                          `version: 0` placeholder when none exists yet).
 *  - `PUT ':provider'`   → create (`expectedVersion` 0) or CAS-update under
 *                          `If-Match` (drift → 412, missing → 428).
 *  - `DELETE ':provider'`→ soft-delete.
 *
 * SECRETS: `apiKey` is write-only. No response from any route on this
 * controller carries the ciphertext — presence is reported as `hasKey`. There
 * is deliberately NO reveal route (contrast `GlobalSettingController`'s
 * `:id/reveal`): provider keys are Configured/None only.
 *
 * GOVERNANCE (enforced in `AiProviderConnectionService`, not here, so the rule
 * stays descriptor/data-driven rather than duplicated per surface):
 *   - a TENANT row is permitted only for cloud BYO providers (azure/bedrock);
 *     a self-host engine → `ForbiddenException` (403, a privilege rule on the
 *     caller's own tenant — NOT the 404-over-403 cross-tenant posture);
 *   - a SYSTEM row may be written only by a global admin → 403.
 *
 * Tenant admins are pinned to their CLS tenant by `resolveScopedTenantId`;
 * global admins act cross-tenant — incl. the SYSTEM platform default — via
 * `?tenantId=`. A cross-tenant by-id read returns 404, never 403.
 *
 * ROUTE MAP NOTE: the tenant-facing BYO endpoints (a tenant admin managing its
 * own cloud credentials from the console) are deliberately NOT here yet — they
 * land with the console screens in the follow-up ticket. This controller is the
 * platform/admin surface only.
 */
@ApiTags('Admin: AI Provider Connections')
@ApiBearerAuth()
@Controller('admin/ai-providers')
export class AiProviderConnectionController {
  constructor(
    @Inject(IAiProviderConnectionService)
    private readonly connectionService: IAiProviderConnectionService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @CanRead('GlobalSetting')
  @ApiOperation({ summary: 'List provider connections for the scoped tenant (keys never returned).' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform admins scope with this; tenant admins are pinned.' })
  @ApiResponse({ status: 200, type: [AiProviderConnectionResponse] })
  async list(@Query('tenantId') tenantId?: string): Promise<AiProviderConnectionResponse[]> {
    return this.connectionService.list('llm', this.resolveTenantId(tenantId));
  }

  @Get(':provider')
  @CanRead('GlobalSetting')
  @ApiOperation({ summary: 'Read one provider connection (key never returned; placeholder when absent).' })
  @ApiParam({ name: 'provider', description: 'Serving provider identifier, e.g. `azure`.' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, type: AiProviderConnectionResponse })
  @ApiResponse({ status: 404, description: 'Not found — including a row owned by another tenant.' })
  async getOne(@Param('provider') provider: string, @Query('tenantId') tenantId?: string): Promise<AiProviderConnectionResponse> {
    return this.connectionService.getRow('llm', provider, this.resolveTenantId(tenantId));
  }

  @Put(':provider')
  @CanManage('GlobalSetting')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Create or update one provider connection.',
    description:
      'Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED and the server runs a ' +
      "Compare-And-Set against the row's `_version`. When present the header overrides the body-field " +
      '`expectedVersion`. Version drift → `412`; missing header → `428`. Use `expectedVersion: 0` to create. ' +
      'A supplied `apiKey` is Vault-Transit encrypted and never returned; omitting it leaves the stored key intact.',
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
  @ApiResponse({ status: 403, description: 'Self-hosted provider on a tenant row, or a SYSTEM row without global admin.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async upsert(
    @Param('provider') provider: string,
    @Body() request: UpsertAiProviderConnectionRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('tenantId') tenantId?: string,
  ): Promise<AiProviderConnectionResponse> {
    // Header takes precedence over body when both are present. On a
    // `@RequiresIfMatch()` route the param decorator already 428'd if the
    // header was missing, so the `??` fallback only fires for unit tests and
    // off-route service-to-service traffic. The create case travels through
    // the header too: `If-Match: "0"` parses to 0 (create-intent)
    // and the service CAS decides create-vs-412.
    const dto = { ...request, expectedVersion: expectedFromHeader ?? request.expectedVersion };
    return this.connectionService.upsertRow('llm', provider, dto, this.resolveTenantId(tenantId));
  }

  @Delete(':provider')
  @CanManage('GlobalSetting')
  @ApiOperation({ summary: 'Soft-delete one provider connection.' })
  @ApiParam({ name: 'provider', description: 'Serving provider identifier, e.g. `azure`.' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  @ApiResponse({ status: 403, description: 'Self-hosted provider on a tenant row, or a SYSTEM row without global admin.' })
  async remove(@Param('provider') provider: string, @Query('tenantId') tenantId?: string): Promise<void> {
    return this.connectionService.deleteRow('llm', provider, this.resolveTenantId(tenantId));
  }

  private resolveTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
