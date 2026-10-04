import { IActiveUserContext, IWorkflowRunService, WorkflowRunTraceAccessService, isSuperAdmin } from '@arcaai/applications';
import type { WorkflowRunStatusResponse } from '@arcaai/applications';
import { RUN_PROTOCOL_HEADER } from '@arcaai/async-contract';
import { ResourceType, SysEventType } from '@arcaai/domains';
import { Controller, ForbiddenException, Get, Headers, Inject, Optional, Param, Query, Res } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { CanRead, ForbidApiKey, ForbidServiceAccount } from '../../decorators';
import { StreamScope } from '../auth/decorators/stream-scope.decorator';
import { resolveRunProtocol } from './run-protocol-delivery';
import { WorkflowStreamService } from './workflow-stream.service';

/** TASK-1038 E2 (fix 2) — the admin trace's own stream-ticket namespace (never `workflow_run`). */
export const WORKFLOW_RUN_TRACE_TICKET_NAMESPACE = 'workflow_run_trace';

/**
 * `WorkflowRunTraceController` — TASK-1038 B3a deliverable 3: the ADMIN TRACE of a run,
 * `GET /api/v1/admin/workflow-runs/:runId/trace/stream` (SSE).
 *
 * The console Test tab's view of ANY run of the working tenant — a sandbox run or a real one —
 * delivering EVERY stored protocol-v2 event unchanged (protocol-v2.md §5: the debug events of
 * TASK-1036 §10.3, every node's outputs, `error.detail`), with the same `seq` resume, `ping`
 * and `run.resync` as the business plane (`WorkflowStreamService.streamRun`, `plane: 'admin'`).
 * It is v2 only: there is no legacy shape of a stream that did not exist before this ticket.
 *
 * Mounted beside `WorkflowRunController`'s JSON `GET admin/workflow-runs/:runId/trace` (the read
 * model's per-node rollup), which keeps its path; this is its live counterpart.
 *
 * Console only. `@ForbidApiKey()` (admin plane, policy A2) and `@ForbidServiceAccount()` — the
 * trace never exists on a machine plane. A browser `EventSource` authenticates with a single-use
 * `?ticket=` scoped `workflow_run_trace:<runId>` — TASK-1038 E2 (fix 2): its own namespace, minted
 * ONLY by the JWT `POST /auth/stream-ticket` after the trace's audience check and the run's
 * ownership. The business `workflow_run:` ticket (mintable by machine credentials) is refused.
 */
@ApiBearerAuth()
@ApiTags('admin-workflow-runs')
@ForbidApiKey()
@ForbidServiceAccount()
@Controller('admin/workflow-runs')
export class WorkflowRunTraceController {
  constructor(
    @Inject(IWorkflowRunService) private readonly workflowRunService: IWorkflowRunService,
    private readonly traceAccess: WorkflowRunTraceAccessService,
    private readonly workflowStreamService: WorkflowStreamService,
    private readonly cls: ClsService<IActiveUserContext>,
    // TASK-1036 (lane B6b) — the audited-view broadcast. `@Optional()`: a Nest context without the
    // event bus still streams; the sys-event fan-out is what persists the audit row.
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  @Get(':runId/trace/stream')
  @CanRead('WorkflowRun')
  // TASK-1038 E2 (fix 2) — its OWN namespace. A `workflow_run:` ticket is mintable by an API key or a
  // service account on the business route and restores the bound human; it must never open this.
  @StreamScope({ namespace: WORKFLOW_RUN_TRACE_TICKET_NAMESPACE, param: 'runId' })
  // AUTH-NOTE: `@CanRead('WorkflowRun')` UNDERSTATES this route's gate. A clinician may hold
  // `read:WorkflowRun`, but the trace carries every event of the run, PHI and admin-only debug
  // data included (protocol-v2.md §5), so `WorkflowRunTraceAccessService.assertCanTrace` admits a
  // SUPER_ADMIN or a TENANT_ADMIN of the working tenant only (403 `RUN_TRACE_FORBIDDEN`). That
  // gate is row-INDEPENDENT and runs first; a foreign or unknown run is still the house 404.
  @ApiOperation({
    summary: 'SSE: the admin trace of a run — every run protocol v2 event (debug events, all node outputs), with resume.',
    description:
      'Run protocol v2 only: every frame is one `{ seq, runId, type, ts, nodeId?, data }` envelope (`event:` = type, `id:` = seq), including the ' +
      'admin-audience debug events (input.validated, data.bound, binding.warning, consultation.read, transcript.*, prompt.composed, model.request, ' +
      'guardrail.*, output.validated) and `output.data` with `visibility: admin`. Resume with `Last-Event-ID: <seq>` or `?after=<seq>`. Loss is ' +
      'signalled with `run.resync`. Super administrators and tenant administrators of the working tenant only; patient data is shown and the ' +
      'read is audited. Accepts `Authorization: Bearer <jwt>` or a single-use `?ticket=` (scope `workflow_run_trace:<runId>`, minted only by ' +
      '`POST /auth/stream-ticket`; a `workflow_run:` ticket is refused).',
  })
  @ApiParam({ name: 'runId', description: 'The domain run id (sandbox or real).' })
  @ApiHeader({ name: 'Last-Event-ID', required: false, description: 'The `seq` of the last event received. Omit on a first connect.' })
  @ApiHeader({ name: RUN_PROTOCOL_HEADER, required: false, description: 'Optional; when present it must be `2`.' })
  @ApiQuery({ name: 'after', required: false, description: 'Resume cursor (`seq`) for a client that cannot set headers.' })
  @ApiQuery({ name: 'protocol', required: false, description: 'Optional; when present it must be `2`.' })
  @ApiResponse({ status: 400, description: 'A protocol other than 2, or a cursor that is not a decimal seq.' })
  @ApiResponse({ status: 403, description: '`RUN_TRACE_FORBIDDEN` — not a super administrator or a tenant administrator of this tenant; or no working tenant selected.' })
  @ApiResponse({ status: 404, description: 'Run not found for the tenant (absent or belongs to another tenant).' })
  async streamTrace(
    @Param('runId') runId: string,
    @Res() res: Response,
    @Headers('Last-Event-ID') lastEventId?: string,
    @Query('after') after?: string,
    @Query('protocol') protocol?: string,
    @Headers(RUN_PROTOCOL_HEADER) protocolHeader?: string,
  ): Promise<void> {
    const tenantId = this.resolveWorkingTenantId();
    await this.traceAccess.assertCanTrace({ user: this.cls.get('user'), serviceAccount: this.cls.get('serviceAccount'), tenantId });
    // v2 only: an explicit selection must be `2` (400 otherwise); no selection means `2`.
    resolveRunProtocol({ header: protocolHeader, query: protocol });
    // The FIRST successful ownership read is the open; the stream re-reads status (R-2) without
    // re-auditing. A 404 never reaches the audit.
    let audited = false;

    await this.workflowStreamService.streamRun({
      runId,
      res,
      plane: 'admin',
      protocol: '2',
      lastEventId,
      after,
      // Ownership (404 for a foreign or unknown run) AND the R-2 terminal re-read: the run read model.
      readStatus: async (): Promise<WorkflowRunStatusResponse> => {
        const run = await this.workflowRunService.getRun(tenantId, runId);
        if (!audited) {
          audited = true;
          this.auditTraceOpened(tenantId, run);
        }
        return {
          runId: run.runId,
          slug: run.workflowSlug,
          workflowVersionNumber: run.workflowVersionNumber,
          status: run.status,
          stages: [],
          startedAt: run.startedAt,
          endedAt: run.endedAt,
        } as unknown as WorkflowRunStatusResponse;
      },
    });
  }

  /**
   * TASK-1036 (lane B6b) — opening the trace is a PHI read (protocol-v2.md §5), audited like the
   * other PHI reads: ONE `ResourceViewed` with `forceAuditLog`, naming who opened which run in which
   * tenant. Identifiers only — never an event, an output or an error detail.
   */
  private auditTraceOpened(tenantId: string, run: { runId: string; workflowSlug: string; workflowVersionNumber: number; isSandbox: boolean }): void {
    const user = this.cls.get('user');
    this.eventEmitter?.emit(SysEventType.ResourceViewed, {
      responsibleEntityId: user?.id,
      resourceType: ResourceType.WorkflowRun,
      resourceId: run.runId,
      correlationId: this.cls.get('correlationId') ?? undefined,
      tenantId,
      forceAuditLog: true,
      data: {
        action: 'workflowRunTraceOpened',
        runId: run.runId,
        workflowSlug: run.workflowSlug,
        workflowVersionNumber: run.workflowVersionNumber,
        isSandbox: run.isSandbox,
      },
    });
  }

  /** Tier 30–49 working tenant (the sibling `WorkflowRunController`'s rule). */
  private resolveWorkingTenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new ForbiddenException(isSuperAdmin(this.cls.get('user')) ? 'No working tenant selected' : 'Tenant context required to trace a workflow run');
    }
    return tenantId;
  }
}
