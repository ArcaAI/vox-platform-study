import {
  EffectiveSttConfigResponse,
  IActiveUserContext,
  ITenantSttConfigService,
  PipelineResponse,
  SetSttFallbackRequest,
  TenantSttConfigResponse,
} from '@arcaai/applications';
import { Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { resolveScopedTenantId } from '../../shared/tenant-scope';
import { ApiDeprecated, Authorize, ExpectedVersion, RequiresIfMatch, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/** TASK-861 — every route on this controller is deprecated; removed in R4 with `TenantSttConfig` (replacement: the ASR Agent's `fallback` block, `/admin/agents`, TASK-863). */
const DEPRECATION = { ticket: 'TASK-861', removeIn: 'R4', replacement: '/api/v1/admin/agents (task SPEECH_TO_TEXT, TASK-863)' } as const;

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
 *
 * TASK-862 removed the `credentials/**` facade (masked list / set / remove /
 * test): the one credential editor is `admin/providers/stt/:provider` and the
 * one probe is `POST admin/providers/stt/:provider/test`. The fallback routes
 * that remain retire under TASK-861.
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
@RequiredSvcScopes('svc:admin:tenant-stt-config:manage')
@Controller('admin/stt-config')
@Authorize()
/** @deprecated TASK-861 — removed in R4 with `TenantSttConfig`. */
export class TenantSttConfigAdminController {
  constructor(
    @Inject(ITenantSttConfigService) private readonly configService: ITenantSttConfigService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @ApiDeprecated(DEPRECATION)
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

  @ApiDeprecated(DEPRECATION)
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

  @ApiDeprecated(DEPRECATION)
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

  @ApiDeprecated(DEPRECATION)
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

  /** Tenant admins → own tenant; super-admins → `?tenantId=` (or CLS tenant). */
  private resolveTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
