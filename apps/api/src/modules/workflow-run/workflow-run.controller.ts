import { CursorPage, IActiveUserContext, isSuperAdmin, IWorkflowRunService, RunTraceResponse, WorkflowRunResponse } from '@arcaai/applications';
import { Controller, ForbiddenException, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanRead, RequiredScopes } from '../../decorators';
import { ListWorkflowRunsQuery } from './dto';

/**
 * WorkflowRunController — the tenant-scoped runs/observability read plane
 * (TASK-723), mounted at `/admin/workflow-runs/*` (global prefix →
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
 * Gated at the class level by `@CanRead('WorkflowRun')` — read-only.
 *
 * Distinct from `/admin/agent-trajectory` (tier 10-19, super-admin
 * cross-tenant platform ops — see `AgentTrajectoryController`) and from the
 * existing `/ai-operations/runs` admin-console screen it backs: this
 * controller is the DEFINITION-scoped tenant view TASK-723 adds (README
 * §2.4) — cross-linked, not a fork.
 */
@ApiBearerAuth()
@ApiTags('admin-workflow-runs')
@RequiredScopes('admin:workflow-run:read')
@Controller('admin/workflow-runs')
@CanRead('WorkflowRun')
export class WorkflowRunController {
  constructor(
    @Inject(IWorkflowRunService)
    private readonly workflowRunService: IWorkflowRunService,
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
  @ApiOperation({ summary: 'A single run. Cross-tenant / nonexistent id → 404 (never 403).' })
  @ApiParam({ name: 'runId', description: 'The domain run id.' })
  @ApiResponse({ status: 200, type: WorkflowRunResponse })
  @ApiResponse({ status: 404, description: 'Run not found for the tenant (absent or belongs to another tenant).' })
  async getRun(@Param('runId') runId: string): Promise<WorkflowRunResponse> {
    const tenantId = this.resolveWorkingTenantId();
    return this.workflowRunService.getRun(tenantId, runId);
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
