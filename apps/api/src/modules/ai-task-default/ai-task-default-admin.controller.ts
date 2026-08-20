import {
  AI_TASK_KEYS,
  AI_TASK_MODEL_TASK_TYPES,
  AiModelService,
  AiTaskDefaultResponse,
  AiTaskKey,
  EffectiveAiTaskDefaultResponse,
  IActiveUserContext,
  IAiTaskDefaultService,
  ModelResponse,
  UpsertAiTaskDefaultRequest,
} from '@arcaai/applications';
import { BadRequestException, Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanManage, CanRead, ExpectedVersion, RequiresIfMatch, ForbidApiKey, RequiredSvcScopes } from '../../decorators';
import { resolveScopedTenantId } from '../../shared/tenant-scope';

/**
 * AiTaskDefaultAdminController — the admin surface for per-tenant
 * "default model for AI task X" rows (`guardrail.validate`, `nlp.ner`,
 * `nlp.classification`), mounted at `/admin/ai-task-defaults` (global prefix →
 * `/api/v1/admin/ai-task-defaults`). Mirrors `TenantTtsConfigAdminController`:
 * `resolveScopedTenantId` scoping, `If-Match` OCC on the row PUT.
 *
 *  - `GET ''?taskKey=`  → the RESOLVED effective default (tenant row → SYSTEM
 *    row → null/service-env fallback). Omit `taskKey` to get the effective
 *    response for ALL task keys at once (array — one round-trip for the UI).
 *  - `GET 'row'?taskKey=`  → ONE raw, editable row (`version` drives the OCC
 *    token; a `version:0` placeholder when none exists yet).
 *  - `PUT 'row'?taskKey=`  → create (`expectedVersion` 0) or CAS-update under
 *    `If-Match` (drift → 412, missing → 428).
 *
 * Tenant admins are pinned to their CLS tenant; super admins act cross-tenant
 * — incl. the SYSTEM-tenant platform default — via `?tenantId=`. GOVERNANCE:
 * writes under the `nlp.`, `harness.` task-key prefixes
 * (SUPER_ADMIN_ONLY_TASK_PREFIXES in `@arcaai/applications`) are
 * SUPER_ADMIN-ONLY. The SERVICE enforces it with a `ForbiddenException` (a
 * deliberate 403, not the 404-over-403 tenancy posture: it is a privilege
 * rule on a key the caller can already read, not a cross-tenant existence
 * probe). Tenant admins may READ the effective default but cannot write those
 * task keys; runtime resolution uses the SYSTEM row only.
 *
 * `text.*` and, since TASK-735 Phase 0 (owner decision 2026-08-16, reversing
 * the 2026-07-17 super-admin-only directive), `guardrail.*` are
 * tenant-admin configurable — `getEffective` honours the tenant row and
 * `upsertRow` accepts tenant writes for those keys. `guardrail.*` carries an
 * ADDITIONAL platform floor on top of that (D2, tighten-only): a tenant
 * write must name a `modelSlug` that resolves to a SYSTEM-tenant `AiModel`
 * row (the platform-approved list) — also a `ForbiddenException`. A
 * `featureGuardrailModelSelection` entitlement ceiling is catalogued but not
 * yet enforced (needs a DB migration outside TASK-735 Phase 0's scope).
 */
@ApiBearerAuth()
@ApiTags('admin-ai-task-defaults')
@ApiExtraModels(EffectiveAiTaskDefaultResponse)
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:ai-task-default:manage')
@Controller('admin/ai-task-defaults')
export class AiTaskDefaultAdminController {
  constructor(
    @Inject(IAiTaskDefaultService) private readonly aiTaskDefaultService: IAiTaskDefaultService,
    private readonly aiModelService: AiModelService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get('options')
  @CanRead('AiTaskDefault')
  @ApiOperation({
    summary: 'List the registry models selectable as the default for one AI task key',
    description:
      'ENABLED AiModel rows whose taskType is compatible with the key (guardrail.validate → GUARDRAIL, nlp.ner → ' +
      'TOKEN_CLASSIFICATION, nlp.classification → TEXT_CLASSIFICATION). Read via the SHARED-READ registry query (r2605 ' +
      'Finding E): visibility is [caller tenant, SYSTEM] de-duplicated by slug (tenant clone wins), so tenant admins get ' +
      'their picker options here — including the SYSTEM catalog — without needing the super-admin-only /admin/ai-models surface.',
  })
  @ApiQuery({ name: 'taskKey', required: true, enum: [...AI_TASK_KEYS] })
  @ApiResponse({ status: 200, type: ModelResponse, isArray: true })
  @ApiResponse({ status: 400, description: 'Unknown or missing taskKey.' })
  async getOptions(@Query('taskKey') taskKey: string): Promise<ModelResponse[]> {
    this.assertKnownTaskKey(taskKey);
    // r2605 Finding E — the exact-tenant getByTaskType pinned the CLS tenant,
    // which DEFEATED the SYSTEM-shared-read widening (tenants without clones
    // got an empty picker). The shared-read variant sees [tenant, SYSTEM].
    const models = await this.aiModelService.getByTaskTypeSharedRead(AI_TASK_MODEL_TASK_TYPES[taskKey as AiTaskKey]);
    return models.filter((model) => model.resourceStatus === 'ENABLED');
  }

  @Get()
  @CanRead('AiTaskDefault')
  @ApiOperation({
    summary: 'Resolve the effective default model for one AI task key — or ALL keys when taskKey is omitted',
    description:
      'Cascade: tenant row → SYSTEM platform row → null (the consuming service falls back to its env bootstrap default). ' +
      `Valid task keys: ${AI_TASK_KEYS.join(', ')}. Omit taskKey to receive an array covering every key.`,
  })
  @ApiQuery({ name: 'taskKey', required: false, enum: [...AI_TASK_KEYS], description: 'AI task key. Omit for all keys (array response).' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiResponse({ status: 200, description: 'One EffectiveAiTaskDefaultResponse, or an array of them when taskKey is omitted.' })
  @ApiResponse({ status: 400, description: 'Unknown taskKey.' })
  async getEffective(
    @Query('taskKey') taskKey?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<EffectiveAiTaskDefaultResponse | EffectiveAiTaskDefaultResponse[]> {
    const scopedTenantId = this.resolveTenantId(tenantId);
    if (taskKey !== undefined) {
      this.assertKnownTaskKey(taskKey);
      return this.aiTaskDefaultService.getEffective(taskKey, scopedTenantId);
    }
    return Promise.all(AI_TASK_KEYS.map((key) => this.aiTaskDefaultService.getEffective(key, scopedTenantId)));
  }

  @Get('row')
  @CanRead('AiTaskDefault')
  @ApiOperation({
    summary: 'Get the raw, editable AiTaskDefault row for a (tenant, taskKey)',
    description:
      'Returns the tenant row, or a `version:0` placeholder when none exists yet. The `version` drives the `If-Match` ' +
      'OCC token for the matching `PUT` (create with `expectedVersion: 0`; the global ETagInterceptor stamps `ETag` from it).',
  })
  @ApiQuery({ name: 'taskKey', required: true, enum: [...AI_TASK_KEYS] })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: AiTaskDefaultResponse })
  @ApiResponse({ status: 400, description: 'Unknown or missing taskKey.' })
  async getRow(@Query('taskKey') taskKey: string, @Query('tenantId') tenantId?: string): Promise<AiTaskDefaultResponse> {
    this.assertKnownTaskKey(taskKey);
    return this.aiTaskDefaultService.getRow(taskKey, this.resolveTenantId(tenantId));
  }

  @Put('row')
  @CanManage('AiTaskDefault')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Create or update the (tenant, taskKey) default-model row under optimistic concurrency',
    description:
      '`modelSlug` must resolve to an ENABLED AiModel in [tenant, SYSTEM] with a taskType compatible with the key. ' +
      '`If-Match` (RFC 7232) carries the version read from the prior GET — `"0"` creates the row, an existing version ' +
      'CASes against `_version` (drift → 412, missing → 428). `nlp.*`/`harness.*` keys are SUPER_ADMIN-ONLY (403 for ' +
      'tenant admins). `guardrail.*` is tenant-admin configurable (TASK-735), but the slug must resolve to a ' +
      'SYSTEM-tenant AiModel row (the platform-approved list) — also 403 otherwise.',
  })
  @ApiQuery({ name: 'taskKey', required: true, enum: [...AI_TASK_KEYS] })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"0"` to create).',
    required: true,
    example: '"0"',
  })
  @ApiResponse({ status: 200, type: AiTaskDefaultResponse })
  @ApiResponse({ status: 400, description: 'Unknown task key, or a model slug that is unknown or incompatible with the task.' })
  @ApiResponse({
    status: 403,
    description:
      'nlp.*/harness.* keys are super-admin-only. guardrail.* is tenant-admin configurable (TASK-735) but rejects a ' +
      'modelSlug outside the platform-approved (SYSTEM-tenant) list.',
  })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async upsertRow(
    @Body() request: UpsertAiTaskDefaultRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('taskKey') taskKey: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<AiTaskDefaultResponse> {
    this.assertKnownTaskKey(taskKey);
    const dto = { ...request, expectedVersion: expectedFromHeader ?? request.expectedVersion };
    return this.aiTaskDefaultService.upsertRow(taskKey, dto, this.resolveTenantId(tenantId));
  }

  /** 400 for anything outside the fixed task-key registry (defense before the service re-checks). */
  private assertKnownTaskKey(taskKey: string | undefined): void {
    if (!taskKey || !(AI_TASK_KEYS as readonly string[]).includes(taskKey)) {
      throw new BadRequestException(`Unknown taskKey '${taskKey ?? ''}'. Valid task keys: ${AI_TASK_KEYS.join(', ')}`);
    }
  }

  /** Tenant admins → own tenant; super admins → `?tenantId=` (or CLS working tenant). */
  private resolveTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
