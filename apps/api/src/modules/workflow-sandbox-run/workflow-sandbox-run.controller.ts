import {
  IWorkflowSandboxRunService,
  SandboxRunCancelResponse,
  SandboxRunResponse,
  SandboxRunStatusResponse,
  StartSandboxRunRequest,
} from '@arcaai/applications';
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CanCreate, CanRead, CanUpdate, RequiredScopes } from '../../decorators';
import { StreamScope } from '../auth/decorators/stream-scope.decorator';
import { WorkflowSandboxStreamService } from './workflow-sandbox-stream.service';

/**
 * `WorkflowSandboxRunController` — the Workbench's run surface (TASK-721 Phase C), mounted at
 * `admin/workflow-definitions/:definitionId/sandbox-runs` (global prefix ->
 * `/api/v1/admin/workflow-definitions/:definitionId/sandbox-runs`).
 *
 * Session-JWT admin console ONLY — unlike `WorkflowsController` (TASK-722's exposure plane,
 * `/workflows/:slug/…`, API-key or JWT, published-only, always `sandbox: false`), this surface
 * runs ANY (DRAFT or published) version of the tenant's OWN `WorkflowDefinition`, always
 * `sandbox: true`. Gated with the SAME `admin:workflow-definition:manage` scope
 * `WorkflowDefinitionController` uses — a sandbox test run is, in spirit, a definition-testing
 * action, and reusing an already-registered scope avoids growing the scope registry for a
 * surface with no API-key consumer.
 *
 * Tenancy is service-enforced (rule 04): `WorkflowSandboxRunService` resolves `tenantId`
 * exclusively from CLS; a cross-tenant/unknown `definitionId` or `runId` -> 404 (never 403).
 */
@ApiBearerAuth()
@ApiTags('admin-workflow-sandbox-runs')
@RequiredScopes('admin:workflow-definition:manage')
@Controller('admin/workflow-definitions/:definitionId/sandbox-runs')
export class WorkflowSandboxRunController {
  constructor(
    @Inject(IWorkflowSandboxRunService) private readonly workflowSandboxRunService: IWorkflowSandboxRunService,
    private readonly workflowSandboxStreamService: WorkflowSandboxStreamService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @CanCreate('WorkflowRun')
  @ApiOperation({ summary: 'Start a sandbox run of the CURRENT graph of :definitionId — DRAFT or published, never writes external artifacts.' })
  @ApiParam({ name: 'definitionId' })
  @ApiResponse({ status: 202, type: SandboxRunResponse })
  @ApiResponse({ status: 400, description: 'The graph cannot be compiled (engine gate).' })
  @ApiResponse({ status: 404, description: 'Unknown or cross-tenant definitionId, or (when fixtureId is given) a cross-tenant fixtureId.' })
  async start(@Param('definitionId') definitionId: string, @Body() dto: StartSandboxRunRequest): Promise<SandboxRunResponse> {
    return this.workflowSandboxRunService.startRun(definitionId, dto);
  }

  @Get(':runId')
  @CanRead('WorkflowRun')
  @ApiOperation({ summary: 'Live run status + stages (queried from the interpreter dispatcher).' })
  @ApiParam({ name: 'definitionId' })
  @ApiParam({ name: 'runId' })
  @ApiResponse({ status: 200, type: SandboxRunStatusResponse })
  @ApiResponse({ status: 404, description: 'Cross-tenant runId, or a runId not started against this definitionId.' })
  async getStatus(@Param('definitionId') definitionId: string, @Param('runId') runId: string): Promise<SandboxRunStatusResponse> {
    return this.workflowSandboxRunService.getRunStatus(definitionId, runId);
  }

  @Post(':runId/cancel')
  @HttpCode(HttpStatus.OK)
  @CanUpdate('WorkflowRun')
  @ApiOperation({ summary: "Cancel a sandbox run — the interpreter's allow-listed cancel signal, never a caller-supplied signal name." })
  @ApiParam({ name: 'definitionId' })
  @ApiParam({ name: 'runId' })
  @ApiResponse({ status: 200, type: SandboxRunCancelResponse })
  @ApiResponse({ status: 404, description: 'Cross-tenant runId, or a runId not started against this definitionId.' })
  async cancel(@Param('definitionId') definitionId: string, @Param('runId') runId: string): Promise<SandboxRunCancelResponse> {
    return this.workflowSandboxRunService.cancelRun(definitionId, runId);
  }

  @Get(':runId/stream')
  @CanRead('WorkflowRun')
  @StreamScope({ namespace: 'workflow_run', param: 'runId' })
  @ApiOperation({
    summary: 'SSE progress + result. Accepts `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` (scope `workflow_run:<runId>`).',
    description:
      'Reuses the SAME `workflow_run:<runId>` ticket namespace and mint-time ownership assertion TASK-722 registered (AuthController.assertWorkflowRunScopeOwnership) — a sandbox run is a `WorkflowRun` row like any other, just isSandbox: true. Bridges from a POLLING read of the harness dispatcher (no live event-stream producer exists on the interpreter yet); every reconnect resyncs from the CURRENT live status rather than resuming a gap.',
  })
  @ApiParam({ name: 'definitionId' })
  @ApiParam({ name: 'runId' })
  async stream(@Param('definitionId') definitionId: string, @Param('runId') runId: string, @Res() res: Response): Promise<void> {
    await this.workflowSandboxStreamService.stream(definitionId, runId, res);
  }
}
