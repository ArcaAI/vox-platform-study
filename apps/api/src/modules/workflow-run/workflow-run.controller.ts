import {
  ApproveRunGateInput,
  CursorPage,
  IActiveUserContext,
  isSuperAdmin,
  IUsageAnalyticsService,
  IWorkflowRunService,
  RunGateStateResponse,
  RunTraceResponse,
  WorkflowRunResponse,
} from '@arcaai/applications';
import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, CanRead, ForbidApiKey, ForbidServiceAccount, RequiredSvcScopes } from '../../decorators';
import { ListWorkflowRunsQuery, WorkflowRunDetailResponse } from './dto';

/**
 * WorkflowRunController — the tenant-scoped runs/observability read plane
 * mounted at `/admin/workflow-runs/*` (global prefix →
 * `/api/v1/admin/workflow-runs/*`).
 *
 * Tier 30–49 (rule 13): requires a working tenant. Tenant admins are pinned
 * to their own CLS tenant; a super admin acts on behalf of a working
 * tenant via the BFF's `X-Tenant-Id` header (resolved into CLS by the
 * auth guard upstream), mirroring `DepartmentController.fetchAll`'s guard —
 * SUPER_ADMIN with no working tenant selected yet is rejected here (403,
 * "no tenant selected") rather than reaching the service with an empty
 * tenant id. Cross-tenant / nonexistent run ids are 404 (never 403) —
 * enforced inside `WorkflowRunService` and propagated here.
 *
 * Gated at the class level by `@CanRead('WorkflowRun')`. Read-only EXCEPT
 * `POST :runId/gate/approve`, which overrides it with `@Authorize(['update',
 * 'Consultation'])` — see that route's own AUTH-NOTE for why reading a runs
 * list must not imply the authority to sign a clinical note.
 *
 * Distinct from `/admin/agent-trajectory` (tier 10-19, super-admin
 * cross-tenant platform ops — see `AgentTrajectoryController`) and from the
 * existing `/ai-operations/runs` admin-console screen it backs: this
 * controller is the DEFINITION-scoped tenant view adds (README
 * cross-linked, not a fork.
 */
@ApiBearerAuth()
@ApiTags('admin-workflow-runs')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:workflow-run:read')
@Controller('admin/workflow-runs')
@CanRead('WorkflowRun')
export class WorkflowRunController {
  constructor(
    @Inject(IWorkflowRunService)
    private readonly workflowRunService: IWorkflowRunService,
    // TASK-959 §3.4 — the run's worker CPU is a LEDGER sum, not a run column.
    // Injected here rather than folded into `WorkflowRunService` so the runs
    // read plane keeps knowing nothing about the metering schema, and so the
    // LIST route (which shares the run projection) never pays for it.
    @Inject(IUsageAnalyticsService)
    private readonly usageAnalytics: IUsageAnalyticsService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Tenant-scoped, keyset-paginated, filterable list of workflow-substrate runs. Sandbox runs excluded by default.' })
  @ApiQuery({ name: 'workflowSlug', required: false })
  @ApiQuery({ name: 'workflowVersionId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'trigger', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'includeSandbox', required: false, type: Boolean })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: WorkflowRunResponse, isArray: true })
  async listRuns(@Query() query: ListWorkflowRunsQuery): Promise<CursorPage<WorkflowRunResponse>> {
    const tenantId = this.resolveWorkingTenantId();
    return this.workflowRunService.listRuns(
      tenantId,
      {
        workflowSlug: query.workflowSlug,
        workflowVersionId: query.workflowVersionId,
        status: query.status,
        trigger: query.trigger,
        from: query.from,
        to: query.to,
        includeSandbox: query.includeSandbox,
      },
      { cursor: query.cursor, limit: query.limit },
    );
  }

  @Get(':runId')
  @ApiOperation({
    summary: 'A single run, with the worker CPU it consumed. Cross-tenant / nonexistent id → 404 (never 403).',
    description:
      "`cpuSeconds` is the durable worker's own CPU for this run, summed from the usage ledger rather than read off the run row — so it lands minutes after the run finishes and is null for a run the metering interceptor never saw.",
  })
  @ApiParam({ name: 'runId', description: 'The domain run id.' })
  @ApiResponse({ status: 200, type: WorkflowRunDetailResponse })
  @ApiResponse({ status: 404, description: 'Run not found for the tenant (absent or belongs to another tenant).' })
  async getRun(@Param('runId') runId: string): Promise<WorkflowRunDetailResponse> {
    const tenantId = this.resolveWorkingTenantId();
    // Existence FIRST: a run that is not the caller's must 404 without the
    // ledger being consulted at all, or the metering read becomes an oracle
    // over the run id space.
    const run = await this.workflowRunService.getRun(tenantId, runId);
    // By the run's SESSION id, not the path's run id: a WORKFLOW ledger row's
    // `requestId` is Temporal's execution-attempt id, so the domain run id
    // matched nothing. `sessionId` is the key this run already joins its own
    // trajectory steps by (`workflow-run.prisma:10-20`).
    const cpuSeconds = await this.usageAnalytics.getWorkflowRunCpuSeconds(tenantId, run.sessionId);
    return Object.assign(new WorkflowRunDetailResponse(), run, { cpuSeconds });
  }

  @Get(':runId/trace')
  @ApiOperation({
    summary:
      'The CQRS-lite read shape: the run row plus its per-node rollup, assembled from ONE bounded trajectory read. Cross-tenant / nonexistent id → 404.',
  })
  @ApiParam({ name: 'runId', description: 'The domain run id.' })
  @ApiResponse({ status: 200, type: RunTraceResponse })
  @ApiResponse({ status: 404, description: 'Run not found for the tenant (absent or belongs to another tenant).' })
  async getRunTrace(@Param('runId') runId: string): Promise<RunTraceResponse> {
    const tenantId = this.resolveWorkingTenantId();
    return this.workflowRunService.getRunTrace(tenantId, runId);
  }

  @Get(':runId/gate')
  @ApiOperation({
    summary: "Live state of the run's human-approval gate, read from the gate child workflow. Cross-tenant / nonexistent id → 404.",
    description:
      'Read LIVE rather than from the read model, deliberately: `WorkflowRunStatus` has no ' +
      '"waiting on a human" member, so a run parked at its gate and a run busy generating text ' +
      'are both RUNNING. `exists: false` is the normal answer for every run without a gate — a ' +
      '200, not an error. Key an Approve affordance off `waiting` and nothing else.',
  })
  @ApiParam({ name: 'runId', description: 'The domain run id.' })
  @ApiResponse({ status: 200, type: RunGateStateResponse })
  @ApiResponse({ status: 404, description: 'Run not found for the tenant (absent or belongs to another tenant).' })
  @ApiResponse({ status: 503, description: 'The harness could not be reached — never reported as "no gate".' })
  async getRunGate(@Param('runId') runId: string): Promise<RunGateStateResponse> {
    const tenantId = this.resolveWorkingTenantId();
    return this.workflowRunService.getRunGate(tenantId, runId);
  }

  /**
   * Release a run's human-approval gate.
   *
   * AUTH-NOTE: the class-level `@CanRead('WorkflowRun')` UNDERSTATES this route's real gate, and
   * a method-level decorator overrides it here on purpose. Signing a clinical note is not a
   * workflow-run-observability action — reading a runs list must never imply the authority to
   * sign. `update:Consultation` is the ability that governs clinical content today, so it is the
   * one required here; the run row's tenant scope (asserted in the service, 404-over-403) is the
   * separate, orthogonal boundary.
   *
   * The recorded clinician is the ACTING user, resolved server-side in the service. There is no
   * request field that can name a different signer, by construction — see `ApproveRunGateInput`.
   */
  @Post(':runId/gate/approve')
  @Authorize(['update', 'Consultation'])
  // SVC-NOTE — CLOSED to the machine class, OVERRIDING the class-level
  // `@RequiredSvcScopes('svc:admin:workflow-run:read')`. Reading a runs list must
  // never imply the authority to sign, as the AUTH-NOTE above already says; a
  // clinician decision on clinical content is the same category of act that keeps
  // impersonation and consent grants machine-closed under decision D-3.
  //
  // This changes no behaviour — a service account was already refused here, since
  // `svc:admin:workflow-run:read` implies `read:WorkflowRun`, not the
  // `update:Consultation` this route demands. It changes WHY: a declared boundary
  // instead of an accident of CASL, which is the difference between a rule and a
  // coincidence. It also drops `approveRunGate` from the generated SDK surface,
  // where it would otherwise ship as a method that can only ever 403.
  @ForbidServiceAccount()
  @ApiOperation({
    summary: "Release the run's human-approval gate with a clinician decision.",
    description:
      'The approving clinician is the acting user; it cannot be supplied by the caller. A run ' +
      'with no gate, or whose gate is not currently waiting, is rejected with 400 rather than ' +
      'reporting a sign-off that reached nothing.',
  })
  @ApiParam({ name: 'runId', description: 'The domain run id.' })
  @ApiResponse({ status: 200, type: RunGateStateResponse, description: 'The gate state after the decision was delivered.' })
  @ApiResponse({ status: 400, description: 'This run has no gate, or its gate is not waiting for a decision.' })
  @ApiResponse({ status: 404, description: 'Run not found for the tenant (absent or belongs to another tenant).' })
  async approveRunGate(@Param('runId') runId: string, @Body() body: ApproveRunGateInput): Promise<RunGateStateResponse> {
    const tenantId = this.resolveWorkingTenantId();
    return this.workflowRunService.approveRunGate(tenantId, runId, body ?? {});
  }

  /**
   * Tier 30–49 working-tenant resolution (rule 13 §Routing). A SUPER_ADMIN
   * with no working tenant selected is rejected here — mirrors
   * `DepartmentController.fetchAll`'s guard — rather than reaching the
   * service with an empty tenant id.
   */
  private resolveWorkingTenantId(): string {
    const user = this.cls.get('user');
    const tenantId = this.cls.get('tenantId');
    if (!tenantId && !isSuperAdmin(user)) {
      throw new ForbiddenException('Tenant context required to list workflow runs');
    }
    if (!tenantId) {
      throw new ForbiddenException('No working tenant selected');
    }
    return tenantId;
  }
}
