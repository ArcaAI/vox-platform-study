import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  IEntitlementsService,
  IRateLimitAdminService,
  IRateLimitRuleService,
  type PlanEntitlementResponse,
  type RateLimitExplainResult,
  type RateLimitPolicy,
  type RateLimitRuleView,
} from '@arcaai/applications';
import { Authorize, ExpectedVersion, ForbidApiKey, RequiredSvcScopes, RequiresIfMatch } from '../../decorators';
import { RouteCatalogService, type RouteCatalogEntry } from '../throttle/route-catalog.service';
import {
  CreateRateLimitRuleRequest,
  RateLimitExplainResponse,
  RateLimitPlanResponse,
  RateLimitPolicyResponse,
  RateLimitRuleResponse,
  RouteCatalogEntryResponse,
  SetRateLimitEnabledRequest,
  SetRateLimitPlanRequest,
  SetRateLimitRouteRequest,
  SetRateLimitTierRequest,
  UpdateRateLimitRuleRequest,
} from './dto';

/**
 * System-admin surface for live, DB-backed rate-limit configuration.
 *
 * Reachable at `/api/v1/admin/rate-limit`. Gated to SUPER_ADMIN only: the
 * `manage all` permission is granted exclusively by the `system-full-access`
 * policy (tenant admins hold `manage GlobalSetting` scoped to their own tenant,
 * which must NOT let them retune the platform-wide gateway limits).
 *
 * Every mutation persists a `rate-limit.*` GlobalSetting row and refreshes the
 * AppSettings cache, so changes take effect within the cache window without a
 * redeploy — the same model `dna-regen.*` uses for the cron scheduler.
 */
@ApiTags('admin-rate-limit')
@ApiBearerAuth()
@Authorize(['manage', 'all'])
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:rate-limit:manage')
@Controller('admin/rate-limit')
export class RateLimitAdminController {
  constructor(
    @Inject(IRateLimitAdminService)
    private readonly rateLimitAdmin: IRateLimitAdminService,
    @Inject(IRateLimitRuleService)
    private readonly rules: IRateLimitRuleService,
    @Inject(IEntitlementsService)
    private readonly entitlements: IEntitlementsService,
    private readonly routeCatalog: RouteCatalogService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get the effective rate-limit policy (global flag, tier baselines, known-route overrides).' })
  @ApiOkResponse({ type: RateLimitPolicyResponse })
  getPolicy(): RateLimitPolicy {
    return this.rateLimitAdmin.getPolicy();
  }

  @Put('enabled')
  @ApiOperation({ summary: 'Flip the global rate-limit kill-switch.' })
  @ApiOkResponse({ type: RateLimitPolicyResponse })
  setEnabled(@Body() body: SetRateLimitEnabledRequest): Promise<RateLimitPolicy> {
    return this.rateLimitAdmin.setEnabled(body.enabled);
  }

  @Put('tiers/:tier')
  @ApiOperation({ summary: 'Update a tier baseline (default | strict | heavy | relaxed).' })
  @ApiParam({ name: 'tier', enum: ['default', 'strict', 'heavy', 'relaxed'] })
  @ApiOkResponse({ type: RateLimitPolicyResponse })
  setTier(@Param('tier') tier: string, @Body() body: SetRateLimitTierRequest): Promise<RateLimitPolicy> {
    return this.rateLimitAdmin.setTier(tier, body);
  }

  /**
   * @deprecated — superseded by the `rules` surface below, which
   * governs ANY of the gateway's routes for ANY tenant rather than the five
   * hand-registered slugs. Kept wired (and still honoured by the guard at rank
   * 4.5) so existing SDK callers and the shipped admin screen keep working.
   * Delete once the admin console's Rules tab is the only writer.
   */
  @Put('routes/:routeId')
  @ApiOperation({
    summary: 'Update a per-endpoint override for a known throttled route (e.g. auth.login).',
    description: 'DEPRECATED — use `POST /admin/rate-limit/rules`, which covers every route and supports per-tenant scoping.',
    deprecated: true,
  })
  @ApiParam({ name: 'routeId', example: 'auth.login' })
  @ApiOkResponse({ type: RateLimitPolicyResponse })
  @ApiBadRequestResponse({ description: 'Unknown routeId, or a non-positive limit/ttl.' })
  setRoute(@Param('routeId') routeId: string, @Body() body: SetRateLimitRouteRequest): Promise<RateLimitPolicy> {
    return this.rateLimitAdmin.setRoute(routeId, body);
  }

  // -------------------------------------------------------------------------
  // Route catalog + rules
  // -------------------------------------------------------------------------

  @Get('routes')
  @ApiOperation({
    summary: 'List every gateway route, for picking a rule target.',
    description: 'Built at boot from the same module walk that produces `route-manifest.json`, so the two can never disagree about what exists.',
  })
  @ApiOkResponse({ type: [RouteCatalogEntryResponse] })
  @ApiForbiddenResponse({ description: 'Not a super admin, or an API-key credential.' })
  listRoutes(): readonly RouteCatalogEntry[] {
    return this.routeCatalog.list();
  }

  @Get('rules')
  @ApiOperation({
    summary: 'List rate-limit rules.',
    description: 'Ranks 1, 2 and 4 of the precedence chain. Filter by `tenantId`, or by `scope` to separate platform-wide from tenant-scoped rules.',
  })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiQuery({ name: 'scope', required: false, enum: ['platform', 'tenant'] })
  @ApiOkResponse({ type: [RateLimitRuleResponse] })
  @ApiForbiddenResponse({ description: 'Not a super admin, or an API-key credential.' })
  listRules(@Query('tenantId') tenantId?: string, @Query('scope') scope?: 'platform' | 'tenant'): Promise<RateLimitRuleView[]> {
    return this.rules.list({ tenantId, scope });
  }

  @Get('rules/:id')
  @ApiOperation({
    summary: 'Get one rate-limit rule.',
    description: 'Returns the rule plus its `version`, which is the ETag a subsequent PATCH must echo back as `If-Match`.',
  })
  @ApiOkResponse({ type: RateLimitRuleResponse })
  @ApiNotFoundResponse({ description: 'No such rule.' })
  getRule(@Param('id') id: string): Promise<RateLimitRuleView> {
    return this.rules.getById(id);
  }

  @Post('rules')
  @ApiOperation({
    summary: 'Create a rate-limit rule.',
    description:
      'Omit `tenantId` for a platform-wide route rule (rank 4). Supply one for a tenant rule — `routeMatch: "*"` makes it tenant-wide (rank 2), any other pattern makes it tenant × route (rank 1).',
  })
  @ApiOkResponse({ type: RateLimitRuleResponse })
  @ApiBadRequestResponse({ description: 'Malformed `routeMatch`, a non-positive limit/window, or `*` on a platform-scoped rule.' })
  @ApiConflictResponse({ description: 'A rule already covers this scope + pattern, or the scope is at its rule cap.' })
  @ApiForbiddenResponse({ description: 'Not a super admin, or an API-key credential.' })
  createRule(@Body() body: CreateRateLimitRuleRequest): Promise<RateLimitRuleView> {
    return this.rules.create(body);
  }

  @Patch('rules/:id')
  @RequiresIfMatch()
  @ApiOperation({ summary: 'Update a rate-limit rule.', description: 'Optimistic concurrency: send the rule’s ETag as `If-Match`.' })
  @ApiOkResponse({ type: RateLimitRuleResponse })
  @ApiBadRequestResponse({ description: 'A non-positive limit or window.' })
  @ApiNotFoundResponse({ description: 'No such rule.' })
  updateRule(
    @Param('id') id: string,
    @Body() body: UpdateRateLimitRuleRequest,
    @ExpectedVersion() expectedVersion: number,
  ): Promise<RateLimitRuleView> {
    return this.rules.update(id, { ...body, expectedVersion });
  }

  @Delete('rules/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a rate-limit rule.',
    description:
      'Soft-deletes the rule and refreshes the throttler cache, so the scope falls back to the next level of the precedence chain immediately.',
  })
  @ApiNotFoundResponse({ description: 'No such rule.' })
  @ApiForbiddenResponse({ description: 'Not a super admin, or an API-key credential.' })
  deleteRule(@Param('id') id: string): Promise<void> {
    return this.rules.remove(id);
  }

  // -------------------------------------------------------------------------
  // Subscription plans — rank 3
  // -------------------------------------------------------------------------

  /*
   * The plan lane is stored on `PlanEntitlement`, whose full CRUD lives on
   * `/admin/entitlements`. It is PROJECTED here — read-through to the same
   * service, no second store — because a super admin managing rate limits
   * should not have to know that one of the five levels happens to be modelled
   * as an entitlement. Rank 3 is part of this screen's story or the screen is
   * incomplete.
   */
  @Get('plans')
  @ApiOperation({
    summary: 'List each subscription plan’s rate limit.',
    description:
      'Rank 3 of the precedence chain, applied to every tenant on the plan. A plan expresses its limit either through a named tier or through an absolute requests-per-window value.',
  })
  @ApiOkResponse({ type: [RateLimitPlanResponse] })
  @ApiForbiddenResponse({ description: 'Not a super admin, or an API-key credential.' })
  async listPlans(): Promise<PlanEntitlementResponse[]> {
    return this.entitlements.listPlanEntitlements();
  }

  @Patch('plans/:plan')
  @ApiOperation({
    summary: 'Set a subscription plan’s rate limit.',
    description:
      'Applies to every tenant on the plan that has no rule and no override of its own. Send `rateLimitPerMinute: null` to clear the absolute value and fall back to the named tier.',
  })
  @ApiParam({ name: 'plan', enum: ['STARTER', 'TRIAL', 'PRO', 'ENTERPRISE'] })
  @ApiOkResponse({ type: RateLimitPlanResponse })
  @ApiBadRequestResponse({ description: 'A non-positive limit or window.' })
  @ApiNotFoundResponse({ description: 'No such plan.' })
  async setPlan(@Param('plan') plan: string, @Body() body: SetRateLimitPlanRequest): Promise<PlanEntitlementResponse> {
    return this.entitlements.updatePlanEntitlement(plan, body);
  }

  @Get('explain')
  @ApiOperation({
    summary: 'Explain how a rate limit resolves for one tenant + route.',
    description:
      'Returns the winning level, the rule that decided, how the counter is bucketed, and what every other level offered. This is the supported answer to "why is this tenant being throttled?".',
  })
  @ApiQuery({ name: 'method', required: true, example: 'POST' })
  @ApiQuery({ name: 'path', required: true, example: '/api/v1/auth/login' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiOkResponse({ type: RateLimitExplainResponse })
  @ApiBadRequestResponse({ description: '`method` or `path` missing.' })
  explain(@Query('method') method: string, @Query('path') path: string, @Query('tenantId') tenantId?: string): Promise<RateLimitExplainResult> {
    return this.rules.explain(tenantId ?? null, method, path);
  }
}
