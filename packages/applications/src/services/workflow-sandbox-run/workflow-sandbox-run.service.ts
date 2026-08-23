import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { generateId, ResourceType, SysEventType, WorkflowTestFixtureRepository } from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { assertEqualTenants, BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { HarnessGatewayService } from '../consultation/harness/harness-gateway.service';
import { IS3Service } from '../baseServices/storage';
import { IWorkflowDefinitionService } from '../workflow-definition';
import { CLAIM_CHECK_BUCKET, mintCompiledConfigClaimCheckRef } from '../workflow-exposure/claim-check';
import { interpreterSessionId, IWorkflowRunService } from '../workflow-run';
import { SandboxRunCancelResponse, SandboxRunResponse, SandboxRunStatusResponse, StartSandboxRunRequest } from './dto';
import { IWorkflowSandboxRunService } from './IWorkflowSandboxRunService';
import { WorkflowSandboxRunDtoMapper } from './workflow-sandbox-run.dto.mapper';

/** Self-hosted MinIO bucket for the compiled-config claim-check — mirrors
 *  `WorkflowExposureService`'s `DEFAULT_CLAIM_CHECK_BUCKET`, itself mirroring the harness's own
 *  `ClaimCheckConfig.bucket` default. Kept as its own literal (not a cross-module import) —
 *  it is a fixed platform constant, not per-service configuration. */

const TERMINAL_RUN_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

/**
 * The Workbench's sandbox-run application service (TASK-721 Phase C). See
 * `IWorkflowSandboxRunService` for the per-method contract and how this differs from the
 * exposure plane (TASK-722).
 */
@Injectable()
export class WorkflowSandboxRunService extends BaseService implements IWorkflowSandboxRunService {
  constructor(
    @Inject(IWorkflowDefinitionService) private readonly workflowDefinitionService: IWorkflowDefinitionService,
    private readonly workflowTestFixtureRepository: WorkflowTestFixtureRepository,
    private readonly harnessGateway: HarnessGatewayService,
    @Inject(IWorkflowRunService) private readonly workflowRunService: IWorkflowRunService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(IS3Service) private readonly s3Service?: IS3Service,
  ) {
    super(eventEmitter, clsService, ResourceType.WorkflowDefinition);
  }

  async startRun(definitionId: string, dto: StartSandboxRunRequest): Promise<SandboxRunResponse> {
    const tenantId = this.requireTenantId();

    const compiled = await this.workflowDefinitionService.getCompiledConfigForSandboxRun(definitionId);
    const payload = await this.resolvePayload(tenantId, dto);

    if (!this.s3Service) {
      throw new ArgumentInvalidException('Sandbox runs are unavailable: no claim-check storage backend is configured.');
    }
    const configRef = await mintCompiledConfigClaimCheckRef(compiled.compiledConfig, CLAIM_CHECK_BUCKET, (b, key, data, contentType) =>
      this.s3Service!.putFile(b, key, data, contentType),
    );

    const runId = generateId();
    const sessionId = interpreterSessionId(runId);

    // Same ordering discipline as WorkflowExposureService.invoke: the ownership-anchor row is
    // written BEFORE the dispatcher call, so a run the dispatcher then fails to start is a
    // recoverable "stuck" row rather than an unattributable one.
    await this.workflowRunService.recordRunStarted({
      tenantId,
      workflowVersionId: compiled.workflowVersionId,
      workflowSlug: compiled.workflowSlug,
      workflowVersionNumber: compiled.workflowVersionNumber,
      definitionName: compiled.definitionName,
      sessionId,
      runId,
      trigger: 'workbench sandbox',
      isSandbox: true,
    });

    const started = await this.harnessGateway.startWorkflowRun({
      runId,
      sessionId,
      workflowVersionId: compiled.workflowVersionId,
      tenantId,
      configRef,
      sandbox: true,
      payload,
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: definitionId,
      data: { action: 'sandboxRun', runId, fixtureId: dto.fixtureId ?? null },
    });

    return WorkflowSandboxRunDtoMapper.toStartResponse(runId, definitionId, started.status);
  }

  async getRunStatus(definitionId: string, runId: string): Promise<SandboxRunStatusResponse> {
    const tenantId = this.requireTenantId();
    const run = await this.resolveOwnedRun(tenantId, definitionId, runId);

    const upstream = await this.harnessGateway.getWorkflowRun(runId);
    await this.syncTerminalStatus(tenantId, run.sessionId, runId, upstream);

    return WorkflowSandboxRunDtoMapper.toStatusResponse(definitionId, upstream);
  }

  async cancelRun(definitionId: string, runId: string): Promise<SandboxRunCancelResponse> {
    const tenantId = this.requireTenantId();
    await this.resolveOwnedRun(tenantId, definitionId, runId);

    const result = await this.harnessGateway.cancelWorkflowRun(runId);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: definitionId,
      data: { action: 'sandboxRunCancel', runId },
    });

    return WorkflowSandboxRunDtoMapper.toCancelResponse(runId, result.status);
  }

  // ============================================================
  // Internals
  // ============================================================

  private requireTenantId(): string {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException('Tenant context required');
    }
    return tenantId;
  }

  /** `dto.input` wins when supplied; else the named fixture's `input`; else `{}`. A foreign-
   *  tenant `fixtureId` is treated the same as "not found" (404-over-403). */
  private async resolvePayload(tenantId: string, dto: StartSandboxRunRequest): Promise<Record<string, unknown>> {
    if (dto.input) return dto.input;
    if (!dto.fixtureId) return {};

    const fixture = await this.workflowTestFixtureRepository.findById(dto.fixtureId);
    assertEqualTenants(fixture, { tenantId });
    return fixture.input as Record<string, unknown>;
  }

  /** Cross-tenant `runId`, or a `runId` not started against `definitionId` -> 404 (never 403). */
  private async resolveOwnedRun(tenantId: string, definitionId: string, runId: string): ReturnType<IWorkflowRunService['getRun']> {
    const run = await this.workflowRunService.getRun(tenantId, runId);
    if (run.workflowVersionId !== definitionId) {
      throw new NotFoundException(`Run '${runId}' not found for workflow definition '${definitionId}'.`);
    }
    return run;
  }

  private async syncTerminalStatus(
    tenantId: string,
    sessionId: string,
    runId: string,
    upstream: Awaited<ReturnType<HarnessGatewayService['getWorkflowRun']>>,
  ): Promise<void> {
    if (!TERMINAL_RUN_STATUSES.has(upstream.status)) return;
    try {
      await this.workflowRunService.recordRunFinished({
        tenantId,
        sessionId,
        runId,
        status: upstream.status as 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT',
        endedAt: upstream.endedAt ? new Date(upstream.endedAt) : undefined,
      });
    } catch {
      // Best-effort read-model sync — the live upstream status is still returned regardless.
    }
  }
}
