import {
  AgentTrajectorySessionsListResponse,
  AgentTrajectoryStepsPageResponse,
  GenerationMetricsAggregateResponse,
  IActiveUserContext,
  IAgentTrajectoryService,
} from '@arcaai/applications';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanRead, RequiredScopes } from '../../decorators';
import { resolveScopedTenantId } from '../../shared/tenant-scope';
import { AggregateGenerationMetricsQuery, ListAgentTrajectorySessionsQuery, ListAgentTrajectoryStepsQuery } from './dto';

/**
 * AgentTrajectoryController — the global-admin read plane
 * for the ordered session trajectory, mounted at `/admin/agent-trajectory/*`
 * (global prefix → `/api/v1/admin/agent-trajectory/*`).
 *
 * Gated at the class level by `@CanRead('AgentTrajectory')` — read-only, so
 * `manage` would be overkill. No Prisma migration is required: the audit
 * `ResourceType` enum only needs values for subjects that emit audit rows,
 * and this read-only surface broadcasts no mutation sys-event. A later
 * ticket adding trajectory writes appends the enum value then.
 *
 * Tenant scoping mirrors `HarnessAdminController`: tenant admins are
 * pinned to their CLS tenant; global-admins act cross-tenant via `?tenantId=`.
 *
 * The read projections deliberately NEVER carry `payloadRef` — the service maps
 * through `AgentTrajectoryStepResponse`, which omits the claim-check/encrypted
 * pointer to session working data. 404-over-403 on cross-tenant reads is
 * enforced inside `IAgentTrajectoryService.listSteps` and propagated here.
 */
@ApiBearerAuth()
@ApiTags('admin-agent-trajectory')
@RequiredScopes('admin:agent-trajectory:read')
@Controller('admin/agent-trajectory')
@CanRead('AgentTrajectory')
export class AgentTrajectoryController {
  constructor(
    @Inject(IAgentTrajectoryService)
    private readonly trajectoryService: IAgentTrajectoryService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get('metrics/generation')
  @ApiOperation({
    summary:
      'Aggregate GenerationStats across LLM_CALL trajectory steps (TTFT median/p95, tok/s avg, stop-reason histogram). Bounded window (default last 7d) + hard row cap.',
  })
  @ApiQuery({ name: 'consultationId', required: false, description: 'Narrow to a single consultation.' })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive lower bound on createdAt (ISO-8601 instant).' })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive upper bound on createdAt (ISO-8601 instant).' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: GenerationMetricsAggregateResponse })
  async aggregateGenerationStats(@Query() query: AggregateGenerationMetricsQuery): Promise<GenerationMetricsAggregateResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.trajectoryService.aggregateGenerationStats(tenantId, {
      consultationId: query.consultationId,
      from: query.from,
      to: query.to,
    });
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List distinct agentic working sessions (grouped by kind + sessionId + runId) with step counts + first/last timestamps' })
  @ApiQuery({ name: 'consultationId', required: false, description: 'Narrow to a single consultation.' })
  @ApiQuery({ name: 'kind', required: false, description: 'LIVE_DOC | HARNESS_DOC | SUMMARY_JOB | EVAL_RUN.' })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive lower bound on createdAt (ISO-8601 instant).' })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive upper bound on createdAt (ISO-8601 instant).' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: AgentTrajectorySessionsListResponse })
  async listSessions(@Query() query: ListAgentTrajectorySessionsQuery): Promise<AgentTrajectorySessionsListResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.trajectoryService.listSessions(
      tenantId,
      { consultationId: query.consultationId, kind: query.kind, from: query.from, to: query.to },
      { page: query.page, limit: query.limit },
    );
  }

  @Get('sessions/:sessionId/steps')
  @ApiOperation({ summary: 'List the ordered steps for a session (seq asc), keyset-paginated. Cross-tenant / nonexistent → 404 (never 403).' })
  @ApiParam({ name: 'sessionId', description: 'Live session id | Temporal workflowId | job id | eval run id.' })
  @ApiQuery({ name: 'runId', required: false, description: 'Narrow to a single run\'s per-run seq stream ("" for non-Temporal).' })
  @ApiQuery({ name: 'cursor', required: false, description: "Opaque keyset cursor from a prior page's nextCursor." })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: AgentTrajectoryStepsPageResponse })
  @ApiResponse({ status: 404, description: 'Trajectory session not found for the tenant (absent or belongs to another tenant).' })
  async listSteps(@Param('sessionId') sessionId: string, @Query() query: ListAgentTrajectoryStepsQuery): Promise<AgentTrajectoryStepsPageResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.trajectoryService.listSteps(tenantId, sessionId, {
      runId: query.runId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  /** Resolve the effective read tenant: tenant admins → own tenant; global-admins → `?tenantId=` (or CLS tenant). */
  private resolveReadTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
