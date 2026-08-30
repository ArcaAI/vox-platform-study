import {
  AI_TASK_KEYS,
  AiRoutingPolicyResponse,
  CreateAiRoutingPolicyRequest,
  EffectiveRoutingPolicyResponse,
  IActiveUserContext,
  IAiRoutingPolicyService,
  UpdateAiRoutingPolicyRequest,
} from '@arcaai/applications';
import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanManage, ExpectedVersion, ForbidApiKey, ForbidServiceAccount, RequiresIfMatch } from '../../decorators';
import { resolveScopedTenantId } from '../../shared/tenant-scope';

/**
 * AiRoutingPolicyAdminController — provider ROUTING and FAILOVER policy
 * (TASK-818 §3A), mounted at `/admin/routing-policies` (global prefix →
 * `/api/v1/admin/routing-policies`).
 *
 * A policy is the ORDERED N-way candidate chain that serves one AI task: which
 * providers, in what order, and what may happen when the first one fails. It
 * sits above `AiProviderConnection` (where a provider lives + how to
 * authenticate to it) and `AiTaskDefault` (one default model per task).
 *
 * ## GOVERNANCE — a super-admin-only surface over per-tenant data
 *
 * The owner requirement is that **default routing and failover policies are
 * managed by the platform super admin**; a tenant expresses itself through its
 * own `AiProviderConnection` rows (its own keys), and a tenant-scoped policy row
 * — which OVERRIDES the platform default on presence — is authored by a super
 * admin on that tenant's behalf.
 *
 * `@CanManage('AiRoutingPolicy')` at class level keeps the deny-by-default boot
 * audit green; the actual super-admin boundary cannot be expressed by any
 * permission decorator (there is no "super admin" subject), so it is enforced
 * IMPERATIVELY in `AiRoutingPolicyService` — see the per-route `AUTH-NOTE:`
 * markers below and the `SUPER_ADMIN_ONLY_TASK_PREFIXES` precedent in
 * `AiTaskDefaultService`.
 *
 * The two failure modes stay distinct: a caller who is not a super admin gets
 * **403** (a privilege rule on a resource they are addressing legitimately); a
 * policy id belonging to a tenant outside the resolved scope gets **404**
 * (404-over-403 — a 403 would confirm the id exists somewhere).
 *
 * ## Scope
 *
 * `?tenantId=` selects which tenant's policies the request acts on; the SYSTEM
 * tenant id addresses the platform default every tenant inherits. Super admins
 * act cross-tenant via that parameter (the console's working-tenant gate
 * normally supplies it), exactly as on `/admin/ai-task-defaults`.
 */
/**
 * ## Credential classes
 *
 * API keys are refused outright (`@ForbidApiKey()`, the admin-plane rule).
 *
 * Service accounts are refused too, and that refusal is DECLARED with
 * `@ForbidServiceAccount()` rather than left to deny-by-default. Since TASK-773
 * the admin plane is the machine class's plane, so silence there is ambiguous
 * rather than safe — the boot audit refuses to start on an undeclared admin
 * route precisely so a missed sweep cannot be mistaken for a deliberate
 * closure. This one is deliberate: a routing-policy write redirects PHI to a
 * different vendor, and granting a machine identity that power needs an owner
 * decision rather than a scope invented in passing. Four admin controllers
 * already sit in this posture (impersonation, consent, monitoring, service
 * health), and the consequence is the same as theirs — the area does not appear
 * in the generated `@arcaai/vox-node` admin plane.
 *
 * To open it later: add `admin:ai-routing-policy:manage` to
 * `apikey-scopes.registry.ts` (the service-account registry renamespaces it to
 * `svc:admin:…` automatically), bump the two exact-count assertions in
 * `apikey-scopes.registry.test.ts`, declare `@RequiredSvcScopes` here, and
 * regenerate the five artifacts.
 */
@ApiBearerAuth()
@ApiTags('admin-ai-routing-policies')
@ApiExtraModels(EffectiveRoutingPolicyResponse)
@ForbidApiKey()
@ForbidServiceAccount()
@CanManage('AiRoutingPolicy')
@Controller('admin/routing-policies')
export class AiRoutingPolicyAdminController {
  constructor(
    @Inject(IAiRoutingPolicyService) private readonly routingPolicyService: IAiRoutingPolicyService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  // AUTH-NOTE: SUPER_ADMIN-only. `@CanManage('AiRoutingPolicy')` satisfies the
  // deny-by-default boot audit; `AiRoutingPolicyService.assertSuperAdmin`
  // enforces the real boundary with a 403. Do not widen without reading it.
  @Get()
  @ApiOperation({
    summary: 'List every routing-policy revision owned by one tenant',
    description:
      'Includes DRAFT, ACTIVE and ARCHIVED revisions so a super admin can see the supersede-only lineage and pick a rollback target. ' +
      'Pass `?tenantId=` to target a tenant, or the SYSTEM tenant id for the platform default. Super-admin only (403 otherwise).',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Target tenant. Defaults to the working tenant elevated into the request context.' })
  @ApiQuery({ name: 'taskKey', required: false, enum: [...AI_TASK_KEYS], description: 'Restrict to one AI task key.' })
  @ApiResponse({ status: 200, type: AiRoutingPolicyResponse, isArray: true })
  @ApiResponse({ status: 400, description: 'Unknown taskKey, or no tenant could be resolved for the request.' })
  @ApiResponse({ status: 403, description: 'Routing policies are managed by super administrators only.' })
  async list(@Query('tenantId') tenantId?: string, @Query('taskKey') taskKey?: string): Promise<AiRoutingPolicyResponse[]> {
    if (taskKey !== undefined) this.assertKnownTaskKey(taskKey);
    return this.routingPolicyService.list(this.resolveTenantId(tenantId), taskKey);
  }

  // AUTH-NOTE: the one route on this controller that is NOT unconditionally
  // super-admin-only, and deliberately so. `getEffective` is the RUNTIME
  // resolution — a tenant resolving what serves ITSELF is ordinary work — so
  // the service asserts super admin only when the target tenant differs from
  // the caller's own (a platform-governance read of someone else's config).
  // In practice this route is still super-admin-only: `manage:AiRoutingPolicy`
  // is granted by the SUPER_ADMIN `manage:all` rule and by no tenant-admin
  // policy in the RBAC seed. The route sits BEFORE `:id` so the literal path
  // is not captured as an id.
  @Get('effective')
  @ApiOperation({
    summary: 'Resolve what actually serves a (tenant, task) right now',
    description:
      'Cascade: the request tenant ACTIVE policy → the SYSTEM platform default → none. Within the winning tier the most-specific `match` wins, ties broken ' +
      'by `priority` then by the authored `policyVersion`. Returns the primary candidate, the ALREADY-GATED fallback chain (same residency class, ' +
      'BAA-covered target, same funding tier — a hop crossing any of those is a rejection, not a fallback), every refused candidate with its reason, and a ' +
      'machine-readable `rejection` when nothing may serve. Naming `explicitProvider` engages the STRICT ruling: a named provider that cannot serve returns ' +
      '`provider_unavailable` rather than a silent substitution.',
  })
  @ApiQuery({ name: 'taskKey', required: true, enum: [...AI_TASK_KEYS] })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Tenant to resolve for. The SYSTEM tenant id resolves the platform default itself.' })
  @ApiQuery({ name: 'model', required: false, description: 'Logical model the request asks for, evaluated against each policy `match.models`.' })
  @ApiQuery({ name: 'contextTokens', required: false, type: Number, description: 'Request context size, for the min/max context-window predicates.' })
  @ApiQuery({ name: 'explicitProvider', required: false, description: 'A provider the caller named explicitly (§3A.4).' })
  @ApiQuery({
    name: 'allowFallbacks',
    required: false,
    type: Boolean,
    description: 'Per-request opt-in, honoured only under STRICT_UNLESS_OPTED_IN. It can never widen the three hard gates.',
  })
  @ApiResponse({ status: 200, type: EffectiveRoutingPolicyResponse })
  @ApiResponse({ status: 400, description: 'Unknown or missing taskKey, or no tenant could be resolved.' })
  @ApiResponse({ status: 403, description: 'Routing policies are managed by super administrators only.' })
  async getEffective(
    @Query('taskKey') taskKey: string,
    @Query('tenantId') tenantId?: string,
    @Query('model') model?: string,
    @Query('contextTokens') contextTokens?: string,
    @Query('explicitProvider') explicitProvider?: string,
    @Query('allowFallbacks') allowFallbacks?: string,
  ): Promise<EffectiveRoutingPolicyResponse> {
    this.assertKnownTaskKey(taskKey);
    const parsedTokens = contextTokens === undefined ? undefined : Number(contextTokens);
    if (parsedTokens !== undefined && !Number.isFinite(parsedTokens)) {
      throw new BadRequestException('`contextTokens` must be a number.');
    }
    return this.routingPolicyService.getEffective(this.resolveTenantId(tenantId), taskKey, {
      model: model ?? null,
      contextTokens: parsedTokens ?? null,
      explicitProvider: explicitProvider ?? null,
      allowFallbacks: allowFallbacks === 'true',
    });
  }

  // AUTH-NOTE: SUPER_ADMIN-only, imperatively in the service (403). A policy id
  // outside the resolved tenant is 404, not 403 (404-over-403).
  @Get(':id')
  @ApiOperation({
    summary: 'Get one routing-policy revision',
    description: 'The `version` field is the OCC token the global ETagInterceptor stamps as `ETag` for the matching PATCH.',
  })
  @ApiParam({ name: 'id', description: 'Policy id (uuid7)' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Target tenant.' })
  @ApiResponse({ status: 200, type: AiRoutingPolicyResponse })
  @ApiResponse({ status: 403, description: 'Routing policies are managed by super administrators only.' })
  @ApiResponse({ status: 404, description: 'No such policy in the resolved tenant (a policy owned by another tenant answers 404, never 403).' })
  async getById(@Param('id') id: string, @Query('tenantId') tenantId?: string): Promise<AiRoutingPolicyResponse> {
    return this.routingPolicyService.getById(id, this.resolveTenantId(tenantId));
  }

  // AUTH-NOTE: SUPER_ADMIN-only, imperatively in the service (403).
  @Post()
  @ApiOperation({
    summary: 'Author a new routing-policy revision (DRAFT)',
    description:
      'Always created as a DRAFT: promotion is its own audited transition (`POST :id/activate`) because it is the moment PHI may start reaching a different ' +
      'vendor. Every candidate needs `connectionRef`, `model`, `residency` and a boolean `baaCovered` — the last two are read by the §3A.4 gates and are ' +
      'never defaulted on your behalf. Omitting `fallback` means NO fallback (maxDepth 0); absence is fail-closed.',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Tenant that will own the policy. The SYSTEM tenant id authors the platform default.' })
  @ApiResponse({ status: 201, type: AiRoutingPolicyResponse })
  @ApiResponse({
    status: 400,
    description: 'Unknown task key, no usable candidate, or a revision number that already exists for this (tenant, task).',
  })
  @ApiResponse({ status: 403, description: 'Routing policies are managed by super administrators only.' })
  async create(@Body() request: CreateAiRoutingPolicyRequest, @Query('tenantId') tenantId?: string): Promise<AiRoutingPolicyResponse> {
    return this.routingPolicyService.create(this.resolveTenantId(tenantId), request);
  }

  // AUTH-NOTE: SUPER_ADMIN-only, imperatively in the service (403); a foreign
  // policy id is 404.
  @Patch(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a routing-policy revision under optimistic concurrency',
    description:
      'A DRAFT is fully editable. On an ACTIVE or ARCHIVED revision only `killSwitch` may change — a served revision is a rollback target and an audit ' +
      '"before", so rewriting it in place would destroy both (§3A.8). To change live routing, author a new revision and activate it. `If-Match` (RFC 7232) ' +
      'carries the version read from the prior GET: drift → 412, missing → 428.',
  })
  @ApiParam({ name: 'id', description: 'Policy id (uuid7)' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Target tenant.' })
  @ApiHeader({ name: 'If-Match', description: 'RFC 7232 strong validator carrying the version the client read.', required: true, example: '"1"' })
  @ApiResponse({ status: 200, type: AiRoutingPolicyResponse })
  @ApiResponse({ status: 400, description: 'No changes to write, an unusable candidate list, or a routing-semantics edit on a non-DRAFT revision.' })
  @ApiResponse({ status: 403, description: 'Routing policies are managed by super administrators only.' })
  @ApiResponse({ status: 404, description: 'No such policy in the resolved tenant.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateAiRoutingPolicyRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('tenantId') tenantId?: string,
  ): Promise<AiRoutingPolicyResponse> {
    const dto = { ...request, expectedVersion: expectedFromHeader ?? request.expectedVersion };
    return this.routingPolicyService.update(id, this.resolveTenantId(tenantId), dto);
  }

  // AUTH-NOTE: SUPER_ADMIN-only, imperatively in the service (403); a foreign
  // policy id is 404.
  @Post(':id/activate')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Promote a DRAFT revision to ACTIVE',
    description:
      'Archives the revision it supersedes (never deletes it — §3A.8 keeps every revision addressable for a one-click rollback), stamps ' +
      '`supersedesVersion` and `activatedAt`, and emits an audit event carrying before/after for both rows. `If-Match` carries the DRAFT version.',
  })
  @ApiParam({ name: 'id', description: 'Policy id (uuid7) of the DRAFT to promote' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Target tenant.' })
  @ApiHeader({ name: 'If-Match', description: 'RFC 7232 strong validator carrying the DRAFT version.', required: true, example: '"1"' })
  @ApiResponse({ status: 201, type: AiRoutingPolicyResponse })
  @ApiResponse({ status: 400, description: 'The revision is not a DRAFT, or its candidate list is unusable.' })
  @ApiResponse({ status: 403, description: 'Routing policies are managed by super administrators only.' })
  @ApiResponse({ status: 404, description: 'No such policy in the resolved tenant.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async activate(
    @Param('id') id: string,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('tenantId') tenantId?: string,
  ): Promise<AiRoutingPolicyResponse> {
    return this.routingPolicyService.activate(id, this.resolveTenantId(tenantId), expectedFromHeader);
  }

  // AUTH-NOTE: SUPER_ADMIN-only, imperatively in the service (403); a foreign
  // policy id is 404.
  @Delete(':id')
  @ApiOperation({
    summary: 'Soft-delete a routing-policy revision',
    description: 'Sets `resourceStatus` to DELETED; the row is retained for the audit trail and is no longer resolved.',
  })
  @ApiParam({ name: 'id', description: 'Policy id (uuid7)' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Target tenant.' })
  @ApiResponse({ status: 200, type: AiRoutingPolicyResponse })
  @ApiResponse({ status: 403, description: 'Routing policies are managed by super administrators only.' })
  @ApiResponse({ status: 404, description: 'No such policy in the resolved tenant.' })
  async deleteById(@Param('id') id: string, @Query('tenantId') tenantId?: string): Promise<AiRoutingPolicyResponse> {
    return this.routingPolicyService.deleteById(id, this.resolveTenantId(tenantId));
  }

  /** 400 for anything outside the fixed task-key registry (defense before the service re-checks). */
  private assertKnownTaskKey(taskKey: string | undefined): void {
    if (!taskKey || !(AI_TASK_KEYS as readonly string[]).includes(taskKey)) {
      throw new BadRequestException(`Unknown taskKey '${taskKey ?? ''}'. Valid task keys: ${AI_TASK_KEYS.join(', ')}`);
    }
  }

  /** Super admins target `?tenantId=`; anyone else is pinned to their own tenant (and the service then 403s). */
  private resolveTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
