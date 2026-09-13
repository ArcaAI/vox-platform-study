import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
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
import { Authorize, ExpectedVersion, ForbidApiKey, RequiredSvcScopes, RequiresIfMatch } from '../../decorators';
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
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:entitlement:manage')
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
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Edit a plan default row.',
    description:
      'Optimistic concurrency is ENFORCED: the `If-Match` header (RFC 7232) is REQUIRED and carries the strong ' +
      'validator the client read from the row GET. When present it overrides the body-field `expectedVersion`. ' +
      'Version drift is `412 Precondition Failed`; a missing header is `428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'plan', example: 'PRO' })
  @ApiOkResponse({ type: PlanEntitlementResponse })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  updatePlan(
    @Param('plan') plan: string,
    @Body() body: UpdatePlanEntitlementRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<PlanEntitlementResponse> {
    // Header wins over the body field when both are present (house pattern —
    // `department.controller.ts#update`). On this `@RequiresIfMatch()` route the
    // param decorator already fired 428 when the header was absent.
    const effective: UpdatePlanEntitlementRequest = expectedFromHeader !== undefined ? { ...body, expectedVersion: expectedFromHeader } : body;
    return this.entitlements.updatePlanEntitlement(plan, effective);
  }

  // ── Per-tenant override (Q1/Q7) + snapshot ────────────────────────────────

  @Get('tenants/:tenantId')
  @ApiOperation({ summary: 'Capability/usage snapshot for ANY tenant (super-admin view).' })
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
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Create-or-update a tenant override ("increase on demand", Q7).',
    description:
      'Optimistic concurrency is ENFORCED: the `If-Match` header (RFC 7232) is REQUIRED. On an EXISTING override ' +
      'echo the validator the row GET returned; on the FIRST create the GET answers `null` (no row, no ETag), so ' +
      'send the create-intent validator `If-Match: "0"`. Version drift is `412 Precondition Failed`; a missing ' +
      'header is `428 Precondition Required`. ' +
      'This is also the write path for `monthlySpendLimitMicros`, the ceiling a tenant sets on its OWN monthly spend ' +
      '(exhausting it answers 402 on the consultation, agent and workflow planes). The SYSTEM tenant ' +
      '(`00000000-…`) is refused with 403: it is a configuration tier, carries no plan, and no request runs as it, ' +
      'so an override written there would never be read.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator: the version read from the override GET, or `"0"` to create the first override.',
    required: true,
    example: '"0"',
  })
  @ApiParam({ name: 'tenantId' })
  @ApiOkResponse({ type: TenantEntitlementResponse })
  @ApiResponse({ status: 403, description: 'The SYSTEM tenant is a configuration tier and carries no entitlement override.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  upsertOverride(
    @Param('tenantId') tenantId: string,
    @Body() body: UpsertTenantEntitlementRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<TenantEntitlementResponse> {
    const effective: UpsertTenantEntitlementRequest = expectedFromHeader !== undefined ? { ...body, expectedVersion: expectedFromHeader } : body;
    return this.entitlements.upsertTenantEntitlement(tenantId, effective);
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
