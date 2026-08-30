import {
  IActiveUserContext,
  PipelinePolicyEffectiveResponse,
  PipelinePolicyResponse,
  PipelinePolicyService,
  UpdatePipelinePolicyRequest,
} from '@arcaai/applications';
import { PipelinePolicyScope } from '@arcaai/domains';
import { BadRequestException, Body, Controller, Get, Put, Query } from '@nestjs/common';
import { resolveScopedTenantId } from '../../shared/tenant-scope';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, ExpectedVersion, RequiresIfMatch, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * PipelinePolicyAdminController — the admin surface
 * for the realtime-pipeline toggle cascade (auto-summary / auto-NER / harness-vs-
 * legacy routing), mounted at `/admin/harness/pipeline-policy` (global prefix →
 * `/api/v1/admin/harness/pipeline-policy`).
 *
 * Mirrors `HarnessAdminController`'s policy surface (`@Authorize`, `If-Match` OCC,
 * CLS tenant resolution) but on a SEPARATE CASL subject (`PipelinePolicy`) so the
 * realtime-toggle admin is cleanly decoupled from harness-gating admin.
 *
 *  - `GET ''`     → the RESOLVED effective cascade (+ per-toggle trace) for a
 *    `tenant [+department] [+doctor]` context (read-only; no ETag).
 *  - `GET 'row'`  → ONE raw, editable policy row (nullable toggles + `version`);
 *    the ETag interceptor stamps `ETag: "<version>"` for the OCC round-trip.
 *  - `PUT 'row'`  → CAS-update-or-create that row under `If-Match`, appending a
 *    WORM `PipelinePolicyChange`. `harnessEnabled` can never be pinned per-doctor
 *    (the service enforces the registered max scope → 400).
 *
 * Tenant scoping mirrors `HarnessAdminController`: tenant admins are pinned to
 * their CLS tenant; super-admins (`isSuperAdmin`) act cross-tenant via `?tenantId=`.
 * The doctor-scope `dnaStyleEnabled` column is NOT writable here — it is Phase 6
 * doctor self-service storage (this surface is tenant/department admin).
 */
@ApiBearerAuth()
@ApiTags('admin-harness')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:pipeline-policy:manage')
@Controller('admin/harness/pipeline-policy')
@Authorize()
export class PipelinePolicyAdminController {
  constructor(
    private readonly policyService: PipelinePolicyService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @Authorize(['read', 'PipelinePolicy'])
  @ApiOperation({
    summary: 'Resolve the effective realtime-pipeline cascade (+ trace) for a tenant/department/doctor context',
    description:
      'Reduces every toggle to a concrete boolean via the cascade (doctor → department → tenant → SYSTEM default → ' +
      'code default) and reports the winning tier per toggle in `trace`. Read-only; consumed by the realtime path.',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiQuery({ name: 'departmentId', required: false, description: 'Include a department tier in the resolution.' })
  @ApiQuery({ name: 'doctorId', required: false, description: 'Include a doctor tier in the resolution.' })
  @ApiResponse({ status: 200, type: PipelinePolicyEffectiveResponse })
  @ApiResponse({ status: 400, description: 'Bad request — no tenant context.' })
  async getEffective(@Query() query: { tenantId?: string; departmentId?: string; doctorId?: string }): Promise<PipelinePolicyEffectiveResponse> {
    const tenantId = this.resolveTenantId(query.tenantId);
    return this.policyService.getEffective({ tenantId, departmentId: query.departmentId, doctorId: query.doctorId });
  }

  @Get('row')
  @Authorize(['read', 'PipelinePolicy'])
  @ApiOperation({
    summary: 'Get ONE raw, editable policy row (nullable toggles) for a scope',
    description:
      'Returns the row at the requested scope (TENANT default), or a `code-default` placeholder (version 0, all ' +
      'toggles null) when none exists yet. The `version` drives the `If-Match` OCC token for the matching `PUT`.',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiQuery({ name: 'scope', required: false, enum: PipelinePolicyScope, description: 'Cascade tier (default TENANT).' })
  @ApiQuery({ name: 'scopeId', required: false, description: 'Scope discriminator (departmentId / userId; omit for TENANT).' })
  @ApiResponse({ status: 200, type: PipelinePolicyResponse })
  @ApiResponse({ status: 400, description: 'Bad request — no tenant context or unknown scope.' })
  async getRow(@Query() query: { tenantId?: string; scope?: string; scopeId?: string }): Promise<PipelinePolicyResponse> {
    const tenantId = this.resolveTenantId(query.tenantId);
    const scope = this.parseScope(query.scope);
    return this.policyService.getRow({ tenantId, scope, scopeId: query.scopeId });
  }

  // AUTH-NOTE: the decorator below UNDERSTATES the real gate, and must not be widened without
  // reading `PipelinePolicyService.assertGlobalOnlyToggles` first. A tenant admin legitimately
  // holds `manage:PipelinePolicy` for every toggle on this route, but the two whose registry
  // descriptor carries `globalOnly: true` — today `harnessEnabled` (guardrail's primary caller)
  // and `autoNerEnabled` (NLP auto-extraction) — are SUPER_ADMIN-only and are refused in the
  // service with a 403. No decorator can express "super admins only, for these fields of this
  // resource", which is why the check is imperative (`05-nestjs-api.md` §Imperative Privilege
  // Checks, which names this lock as one of its canonical examples).
  //
  // The lock is descriptor-driven, so the covered set is NOT a list here or in the service:
  // adding `globalOnly` to a `pipeline.*` descriptor governs another toggle with no code change.
  //
  // 403 is PRIVILEGE, not the 404-over-403 cross-tenant posture: the caller may still READ these
  // toggles and their pinned rows, and a cross-tenant target is rejected separately by
  // `resolveTenantId` above. Read is deliberately ungated.
  @Put('row')
  @Authorize(['manage', 'PipelinePolicy'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Create or update ONE policy row (sparse patch) under optimistic concurrency',
    description:
      'Pins/clears the supplied toggles at the requested scope (omit = unchanged, `null` = clear/inherit). The ' +
      "`If-Match` header (RFC 7232) is REQUIRED on an existing row and CAS'es against `_version` (drift → 412, " +
      'missing → 428); every edit appends a WORM `PipelinePolicyChange` in the same transaction. A toggle pinned ' +
      'beyond its registered max scope (e.g. `harnessEnabled` at DOCTOR) is rejected with 400.',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiQuery({ name: 'scope', required: false, enum: PipelinePolicyScope, description: 'Cascade tier (default TENANT).' })
  @ApiQuery({ name: 'scopeId', required: false, description: 'Scope discriminator (departmentId / userId; omit for TENANT).' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiResponse({ status: 200, type: PipelinePolicyResponse })
  @ApiResponse({ status: 400, description: 'Toggle pinned beyond its max scope (e.g. harnessEnabled at DOCTOR).' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async updateRow(
    @Query() query: { tenantId?: string; scope?: string; scopeId?: string },
    @Body() request: UpdatePipelinePolicyRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<PipelinePolicyResponse> {
    const tenantId = this.resolveTenantId(query.tenantId);
    const scope = this.parseScope(query.scope);
    return this.policyService.upsertRow({
      tenantId,
      scope,
      scopeId: query.scopeId,
      dto: request,
      expectedVersion: expectedFromHeader ?? request.expectedVersion,
    });
  }

  // ───────────────────────── Helpers ─────────────────────────

  /** Resolve the effective tenant: tenant admins → own tenant; super-admins → `?tenantId=` (or CLS tenant). */
  private resolveTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }

  /** Parse the `?scope=` query into the enum, defaulting to TENANT; unknown → 400. */
  private parseScope(raw?: string): PipelinePolicyScope {
    if (raw === undefined || raw === '') return PipelinePolicyScope.TENANT;
    if ((Object.values(PipelinePolicyScope) as string[]).includes(raw)) {
      return raw as PipelinePolicyScope;
    }
    throw new BadRequestException(`Unknown scope '${raw}'. Expected one of: ${Object.values(PipelinePolicyScope).join(', ')}.`);
  }
}
