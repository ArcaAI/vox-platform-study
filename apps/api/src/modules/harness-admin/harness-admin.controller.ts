import {
  EvalRunDetailResponse,
  EvalRunListResponse,
  GateQueueResponse,
  HarnessAuditListResponse,
  HarnessObservabilityService,
  HarnessPolicyResponse,
  HarnessPolicyService,
  IActiveUserContext,
  isSuperAdmin,
  UpdateHarnessPolicyRequest,
} from '@arcaai/applications';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, ExpectedVersion, RequiresIfMatch } from '../../decorators';
import { HarnessOpsClient, HarnessWorkflowActionResult, HarnessWorkflowDetail, HarnessWorkflowListResult } from './harness-ops.client';
import { SignalWorkflowRequest, WorkflowActionRequest } from './dto';

/**
 * HarnessAdminController (TASK-330 Phase 6) — the admin surface for the clinical
 * documentation harness, mounted at `/admin/harness/*` (global prefix →
 * `/api/v1/admin/harness/*`). Mirrors `PromptManagementController` (`@Authorize`,
 * `If-Match` OCC) and `MyTenantController` (CLS tenant resolution).
 *
 * Three concerns:
 *  - Policy: GET/PATCH the caller-tenant policy (`If-Match` OCC) + the platform
 *    GLOBAL-DEFAULT (`policy/global`, super-admin only).
 *  - Observe: read the WORM audit trail (+ integrity verdict), eval runs, and
 *    the clinician gate queue.
 *  - Operate: proxy Temporal workflow ops to the harness via `HarnessOpsClient`,
 *    enforcing tenant ownership on destructive ops (platform super-admins bypass).
 *
 * Tenant scoping mirrors `MyTenantController`/`TenantController`: tenant admins
 * are pinned to their CLS tenant; super-admins (`isSuperAdmin`) act cross-tenant
 * (and may target a tenant via `?tenantId=` on reads). The ETag interceptor sets
 * `ETag: "<version>"` on the policy responses (top-level `version`).
 */
@ApiBearerAuth()
@ApiTags('admin-harness')
@Controller('admin/harness')
@Authorize()
export class HarnessAdminController {
  constructor(
    private readonly policyService: HarnessPolicyService,
    private readonly observabilityService: HarnessObservabilityService,
    private readonly opsClient: HarnessOpsClient,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  // ───────────────────────── Policy ─────────────────────────

  @Get('policy')
  @Authorize(['read', 'HarnessPolicy'])
  @ApiOperation({ summary: "Get the caller tenant's effective harness policy (tenant row over global default over code default)" })
  @ApiResponse({ status: 200, type: HarnessPolicyResponse })
  @ApiResponse({ status: 400, description: 'Bad request — no tenant context.' })
  async getPolicy(): Promise<HarnessPolicyResponse> {
    return this.policyService.getEffectivePolicy();
  }

  @Patch('policy')
  @Authorize(['manage', 'HarnessPolicy'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: "Update the caller tenant's harness policy (created on first edit)",
    description:
      'Sparse patch over the effective policy. Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) ' +
      "is REQUIRED and CAS'es against the row `_version`; drift → 412, missing → 428. Every edit appends a WORM " +
      '`HarnessPolicyChange` (before/after) in the same transaction.',
  })
  @ApiHeader({ name: 'If-Match', description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).', required: true, example: '"1"' })
  @ApiResponse({ status: 200, type: HarnessPolicyResponse })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async updatePolicy(@Body() request: UpdateHarnessPolicyRequest, @ExpectedVersion() expectedFromHeader: number | undefined): Promise<HarnessPolicyResponse> {
    return this.policyService.updatePolicy(request, expectedFromHeader ?? request.expectedVersion);
  }

  @Get('policy/global')
  @Authorize(['read', 'HarnessPolicy'])
  @ApiOperation({ summary: 'Get the platform GLOBAL-DEFAULT harness policy (super-admin only)' })
  @ApiResponse({ status: 200, type: HarnessPolicyResponse })
  @ApiResponse({ status: 403, description: 'Forbidden — platform (super-admin) privileges required.' })
  async getGlobalPolicy(): Promise<HarnessPolicyResponse> {
    this.assertPlatform();
    return this.policyService.getGlobalDefault();
  }

  @Patch('policy/global')
  @Authorize(['manage', 'HarnessPolicy'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update the platform GLOBAL-DEFAULT harness policy (super-admin only)',
    description: 'Same OCC + WORM semantics as `PATCH policy`, targeting the SYSTEM-tenant GLOBAL-DEFAULT row. Restricted to platform super-admins.',
  })
  @ApiHeader({ name: 'If-Match', description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).', required: true, example: '"1"' })
  @ApiResponse({ status: 200, type: HarnessPolicyResponse })
  @ApiResponse({ status: 403, description: 'Forbidden — platform (super-admin) privileges required.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async updateGlobalPolicy(@Body() request: UpdateHarnessPolicyRequest, @ExpectedVersion() expectedFromHeader: number | undefined): Promise<HarnessPolicyResponse> {
    this.assertPlatform();
    return this.policyService.updateGlobalDefault(request, expectedFromHeader ?? request.expectedVersion);
  }

  // ───────────────────────── Observe ─────────────────────────

  @Get('audit')
  @Authorize(['read', 'HarnessAudit'])
  @ApiOperation({ summary: 'List the WORM audit trail (newest-first) + the chain-integrity verdict' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiQuery({ name: 'consultationId', required: false, description: 'Narrow to a single consultation.' })
  @ApiQuery({ name: 'action', required: false, description: 'Narrow to a single HarnessAuditAction (e.g. GATE_DECISION).' })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive lower bound on createdAt (ISO-8601 instant).' })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive upper bound on createdAt (ISO-8601 instant).' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (1–200, default 50).' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Offset into the newest-first list.' })
  @ApiResponse({ status: 200, type: HarnessAuditListResponse })
  async listAudit(
    @Query() query: { tenantId?: string; consultationId?: string; action?: string; from?: string; to?: string; limit?: string; offset?: string },
  ): Promise<HarnessAuditListResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.observabilityService.listAuditEvents(tenantId, {
      consultationId: query.consultationId,
      action: query.action,
      from: query.from,
      to: query.to,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
      offset: query.offset !== undefined ? Number(query.offset) : undefined,
    });
  }

  @Get('eval-runs')
  @Authorize(['read', 'HarnessEval'])
  @ApiOperation({ summary: 'List eval runs (newest-first)' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiQuery({ name: 'goldenSetId', required: false, description: 'Filter to one golden set.' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: EvalRunListResponse })
  async listEvalRuns(@Query() query: { tenantId?: string; goldenSetId?: string; page?: string; limit?: string }): Promise<EvalRunListResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.observabilityService.listEvalRuns(tenantId, {
      goldenSetId: query.goldenSetId,
      page: query.page !== undefined ? Number(query.page) : undefined,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
    });
  }

  @Get('eval-runs/:id')
  @Authorize(['read', 'HarnessEval'])
  @ApiOperation({ summary: 'Get one eval run with its per-case scores' })
  @ApiParam({ name: 'id', description: 'Eval run id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: EvalRunDetailResponse })
  @ApiResponse({ status: 404, description: 'Eval run not found for the tenant.' })
  async getEvalRun(@Param('id') id: string, @Query() query: { tenantId?: string }): Promise<EvalRunDetailResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.observabilityService.getEvalRun(tenantId, id);
  }

  @Get('gate-queue')
  @Authorize(['read', 'HarnessWorkflow'])
  @ApiOperation({ summary: 'List consultations awaiting clinician review with SLA/escalation from the effective policy' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: GateQueueResponse })
  async gateQueue(@Query() query: { tenantId?: string }): Promise<GateQueueResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.observabilityService.gateQueue(tenantId);
  }

  // ───────────────────────── Operate (Temporal proxy) ─────────────────────────

  @Get('workflows')
  @Authorize(['read', 'HarnessWorkflow'])
  @ApiOperation({ summary: 'List harness Temporal document workflows (tenant-filtered)' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant (omit = all tenants).' })
  @ApiQuery({ name: 'status', required: false, description: 'Temporal status filter (e.g. RUNNING).' })
  @ApiQuery({ name: 'consultationId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'pageToken', required: false })
  async listWorkflows(
    @Query() query: { tenantId?: string; status?: string; consultationId?: string; limit?: string; pageToken?: string },
  ): Promise<HarnessWorkflowListResult> {
    const tenantFilter = this.resolveWorkflowListTenant(query.tenantId);
    return this.opsClient.listWorkflows({
      tenantId: tenantFilter,
      status: query.status,
      consultationId: query.consultationId,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
      pageToken: query.pageToken,
    });
  }

  @Get('workflows/:id')
  @Authorize(['read', 'HarnessWorkflow'])
  @ApiOperation({ summary: 'Describe one harness workflow (add ?phase=true for the loop phase)' })
  @ApiParam({ name: 'id', description: 'Temporal workflow id' })
  @ApiQuery({ name: 'phase', required: false, type: Boolean })
  @ApiResponse({ status: 403, description: 'Forbidden — workflow belongs to another tenant.' })
  async describeWorkflow(@Param('id') id: string, @Query() query: { phase?: string }): Promise<HarnessWorkflowDetail> {
    const detail = await this.opsClient.describeWorkflow(id, { phase: query.phase === 'true' });
    this.assertWorkflowOwnership(detail.tenantId);
    return detail;
  }

  @Post('workflows/:id/cancel')
  @Authorize(['manage', 'HarnessWorkflow'])
  @ApiOperation({ summary: 'Cancel a harness workflow (graceful). Tenant admins limited to their own tenant.' })
  @ApiParam({ name: 'id', description: 'Temporal workflow id' })
  @ApiResponse({ status: 403, description: 'Forbidden — workflow belongs to another tenant.' })
  async cancelWorkflow(@Param('id') id: string, @Body() body: WorkflowActionRequest): Promise<HarnessWorkflowActionResult> {
    const ownerTenantId = await this.assertOwnershipForAction(id);
    return this.opsClient.cancelWorkflow(id, { tenantId: ownerTenantId, reason: body.reason });
  }

  @Post('workflows/:id/terminate')
  @Authorize(['manage', 'HarnessWorkflow'])
  @ApiOperation({ summary: 'Terminate a harness workflow (forceful). Tenant admins limited to their own tenant.' })
  @ApiParam({ name: 'id', description: 'Temporal workflow id' })
  @ApiResponse({ status: 403, description: 'Forbidden — workflow belongs to another tenant.' })
  async terminateWorkflow(@Param('id') id: string, @Body() body: WorkflowActionRequest): Promise<HarnessWorkflowActionResult> {
    const ownerTenantId = await this.assertOwnershipForAction(id);
    return this.opsClient.terminateWorkflow(id, { tenantId: ownerTenantId, reason: body.reason });
  }

  @Post('workflows/:id/signal')
  @Authorize(['manage', 'HarnessWorkflow'])
  @ApiOperation({ summary: 'Send a signal to a harness workflow. Tenant admins limited to their own tenant.' })
  @ApiParam({ name: 'id', description: 'Temporal workflow id' })
  @ApiResponse({ status: 403, description: 'Forbidden — workflow belongs to another tenant.' })
  async signalWorkflow(@Param('id') id: string, @Body() body: SignalWorkflowRequest): Promise<HarnessWorkflowActionResult> {
    const ownerTenantId = await this.assertOwnershipForAction(id);
    return this.opsClient.signalWorkflow(id, { tenantId: ownerTenantId, signalName: body.signalName, payload: body.payload });
  }

  // ───────────────────────── Helpers ─────────────────────────

  /** Resolve the effective read tenant: tenant admins → own tenant; super-admins → `?tenantId=` (or CLS tenant). */
  private resolveReadTenantId(queryTenantId?: string): string {
    const user = this.cls.get('user');
    if (isSuperAdmin(user)) {
      const target = queryTenantId ?? this.cls.get('tenantId') ?? user?.tenantId ?? undefined;
      if (!target) throw new BadRequestException('Platform admins must pass ?tenantId= to scope this read.');
      return target;
    }
    const tenantId = this.cls.get('tenantId') ?? user?.tenantId ?? undefined;
    if (!tenantId) throw new BadRequestException('Tenant context is required.');
    if (queryTenantId && queryTenantId !== tenantId) {
      throw new ForbiddenException('You do not have access to this tenant');
    }
    return tenantId;
  }

  /** Workflow-list tenant filter: tenant admins → own tenant; super-admins → optional `?tenantId=` (undefined = all tenants). */
  private resolveWorkflowListTenant(queryTenantId?: string): string | undefined {
    const user = this.cls.get('user');
    if (isSuperAdmin(user)) return queryTenantId;
    const tenantId = this.cls.get('tenantId') ?? user?.tenantId ?? undefined;
    if (!tenantId) throw new BadRequestException('Tenant context is required.');
    if (queryTenantId && queryTenantId !== tenantId) {
      throw new ForbiddenException('You do not have access to this tenant');
    }
    return tenantId;
  }

  /** Platform (super-admin) gate for the GLOBAL-DEFAULT policy routes. */
  private assertPlatform(): void {
    if (!isSuperAdmin(this.cls.get('user'))) {
      throw new ForbiddenException('Editing the harness global-default policy requires platform (super-admin) privileges.');
    }
  }

  /**
   * Enforce tenant ownership of a workflow: super-admins bypass; tenant admins
   * must own the workflow's tenant. Returns the owning tenantId (forwarded to
   * the harness so it can re-scope server-side).
   */
  private async assertOwnershipForAction(workflowId: string): Promise<string | undefined> {
    const detail = await this.opsClient.describeWorkflow(workflowId);
    this.assertWorkflowOwnership(detail.tenantId);
    return detail.tenantId ?? undefined;
  }

  private assertWorkflowOwnership(workflowTenantId: string | null): void {
    const user = this.cls.get('user');
    if (isSuperAdmin(user)) return;
    const callerTenant = this.cls.get('tenantId') ?? user?.tenantId ?? undefined;
    if (!callerTenant || !workflowTenantId || workflowTenantId !== callerTenant) {
      throw new ForbiddenException('You do not have access to this workflow');
    }
  }
}
