import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  DowngradeReport,
  EntitlementCapabilitiesResponse,
  IEntitlementsLifecycleService,
  IEntitlementsService,
  PlanEntitlementResponse,
  TenantEntitlementResponse,
  TrialExpiryReport,
  UpdatePlanEntitlementRequest,
  UpsertTenantEntitlementRequest,
} from '@arcaai/applications';
import { Authorize, RequiredScopes } from '../../decorators';
import { EntitlementsEnabledResponse, SetEnforcementEnabledRequest, TriggerDowngradeRequest } from './dto';

/**
 * SUPER_ADMIN surface for the DB-backed plan-entitlements
 * system. Reachable at `/api/v1/admin/entitlements`.
 *
 * Gated to SUPER_ADMIN via `@Authorize(['manage','all'])` — exactly like
 * {@link RateLimitAdminController}: `manage all` is granted ONLY by the
 * `system-full-access` policy, so a tenant admin (who holds tenant-scoped
 * `manage GlobalSetting`) can never retune the platform-wide matrix or flip the
 * kill-switch. Per-tenant self-service reads live on the separate
 * `MyEntitlementsController` (`read Tenant`, own tenant only).
 *
 * Every quota block raised downstream surfaces as a typed
 * `QuotaExceededException` → mapped to 409 (quantity) / 429 (meter) / 413
 * (storage) by the global `ExceptionInterceptor`.
 */
@ApiTags('admin-entitlements')
@ApiBearerAuth()
@Authorize(['manage', 'all'])
@RequiredScopes('admin:entitlement:manage')
@Controller('admin/entitlements')
export class EntitlementsAdminController {
  constructor(
    @Inject(IEntitlementsService)
    private readonly entitlements: IEntitlementsService,
    @Inject(IEntitlementsLifecycleService)
    private readonly lifecycle: IEntitlementsLifecycleService,
  ) {}

  // ── Kill-switch (Q9) ─────────────────────────────────────────────────────

  @Get('enabled')
  @ApiOperation({ summary: 'Read the global entitlements enforcement kill-switch (Q9).' })
  @ApiOkResponse({ type: EntitlementsEnabledResponse })
  getEnabled(): EntitlementsEnabledResponse {
    return { enabled: this.entitlements.isEnforcementEnabled() };
  }

  @Put('enabled')
  @ApiOperation({ summary: 'Flip the global entitlements enforcement kill-switch (Q9).' })
  @ApiOkResponse({ type: EntitlementsEnabledResponse })
  async setEnabled(@Body() body: SetEnforcementEnabledRequest): Promise<EntitlementsEnabledResponse> {
    const enabled = await this.entitlements.setEnforcementEnabled(body.enabled);
    return { enabled };
  }

  // ── Plan matrix CRUD (Q1) ─────────────────────────────────────────────────

  @Get('plans')
  @ApiOperation({ summary: 'List the per-plan default entitlement matrix.' })
  @ApiOkResponse({ type: PlanEntitlementResponse, isArray: true })
  listPlans(): Promise<PlanEntitlementResponse[]> {
    return this.entitlements.listPlanEntitlements();
  }

  @Get('plans/:plan')
  @ApiOperation({ summary: 'Get a single plan default row.' })
  @ApiParam({ name: 'plan', example: 'PRO' })
  @ApiOkResponse({ type: PlanEntitlementResponse })
  getPlan(@Param('plan') plan: string): Promise<PlanEntitlementResponse> {
    return this.entitlements.getPlanEntitlement(plan);
  }

  @Patch('plans/:plan')
  @ApiOperation({ summary: 'Edit a plan default row (OCC via expectedVersion → 412 on drift).' })
  @ApiParam({ name: 'plan', example: 'PRO' })
  @ApiOkResponse({ type: PlanEntitlementResponse })
  updatePlan(@Param('plan') plan: string, @Body() body: UpdatePlanEntitlementRequest): Promise<PlanEntitlementResponse> {
    return this.entitlements.updatePlanEntitlement(plan, body);
  }

  // ── Per-tenant override (Q1/Q7) + snapshot ────────────────────────────────

  @Get('tenants/:tenantId')
  @ApiOperation({ summary: 'Capability/usage snapshot for ANY tenant (global-admin view).' })
  @ApiParam({ name: 'tenantId' })
  @ApiOkResponse({ type: EntitlementCapabilitiesResponse })
  getTenantSnapshot(@Param('tenantId') tenantId: string): Promise<EntitlementCapabilitiesResponse> {
    return this.entitlements.getCapabilities(tenantId);
  }

  @Get('tenants/:tenantId/override')
  @ApiOperation({ summary: "Get a tenant's entitlement override (null = inherits the plan default)." })
  @ApiParam({ name: 'tenantId' })
  @ApiOkResponse({ type: TenantEntitlementResponse })
  getOverride(@Param('tenantId') tenantId: string): Promise<TenantEntitlementResponse | null> {
    return this.entitlements.getTenantEntitlement(tenantId);
  }

  @Put('tenants/:tenantId/override')
  @ApiOperation({ summary: 'Create-or-update a tenant override ("increase on demand", Q7). OCC required to update.' })
  @ApiParam({ name: 'tenantId' })
  @ApiOkResponse({ type: TenantEntitlementResponse })
  upsertOverride(@Param('tenantId') tenantId: string, @Body() body: UpsertTenantEntitlementRequest): Promise<TenantEntitlementResponse> {
    return this.entitlements.upsertTenantEntitlement(tenantId, body);
  }

  @Delete('tenants/:tenantId/override')
  @ApiOperation({ summary: 'Clear a tenant override back to plan inheritance (nulls the row; reversible — never deleted).' })
  @ApiParam({ name: 'tenantId' })
  async clearOverride(@Param('tenantId') tenantId: string): Promise<{ cleared: true }> {
    await this.entitlements.clearTenantEntitlement(tenantId);
    return { cleared: true };
  }

  // ── Lifecycle actions (Q4/Q10) ─────────────────────────────────────────────

  @Post('tenants/:tenantId/downgrade')
  @ApiOperation({
    summary:
      'Downgrade a tenant plan (Q10). Plan change always applies; newest-first soft-disable of overflow rows runs only when enforcement is ON.',
  })
  @ApiParam({ name: 'tenantId' })
  triggerDowngrade(@Param('tenantId') tenantId: string, @Body() body: TriggerDowngradeRequest): Promise<DowngradeReport> {
    return this.lifecycle.triggerDowngrade(tenantId, body.plan);
  }

  @Post('trial-expiry/run')
  @ApiOperation({ summary: 'Manually run the trial-expiry sweep (Q4): downgrade every expired TRIAL tenant to STARTER, plan-only.' })
  runTrialExpiry(): Promise<TrialExpiryReport> {
    return this.lifecycle.expireTrials();
  }
}
