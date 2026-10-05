import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationFactory,
  ConsultationRepository,
  generateId,
  MediaRepository,
  ResourceType,
  SysEventType,
  TranscriptionJobRepository,
  TranscriptionJobType,
  type TranscriptionJobEntity,
  WorkflowTestFixtureRepository,
} from '@arcaai/domains';
import type { StartWorkflowRunSubject } from '../consultation/harness/harness-gateway.service';
import { CONTEXT_ATTACHMENT_MIME_TYPES, normalizeContextMimeType } from '../consultation-context-schema/context-schema-definition';
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
import { sandboxRunPayload, type SandboxMediaReference } from './sandbox-input-shape';

/** Self-hosted MinIO bucket for the compiled-config claim-check — mirrors
 *  `WorkflowExposureService`'s `DEFAULT_CLAIM_CHECK_BUCKET`, itself mirroring the harness's own
 *  `ClaimCheckConfig.bucket` default. Kept as its own literal (not a cross-module import) —
 *  it is a fixed platform constant, not per-service configuration. */

const TERMINAL_RUN_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

/** TASK-1038 E2 (fix 12) — the STT job statuses of a session that is still live. */
const LIVE_RECORDING_STATUSES: ReadonlySet<string> = new Set(['QUEUED', 'PROCESSING']);

/**
 * The Workbench's sandbox-run application service. See
 * `IWorkflowSandboxRunService` for the per-method contract and how this differs from the
 * exposure plane.
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
    // TASK-1036 OD-15 — sandbox attachments (tenant media) and recordings (STT streaming sessions
    // bound to a sandbox consultation). Trailing + @Optional() so positional fixtures keep their
    // arity; absent, a request that uses either input is refused rather than half-served.
    @Optional() @Inject(MediaRepository) private readonly mediaRepository?: MediaRepository,
    @Optional() @Inject(TranscriptionJobRepository) private readonly transcriptionJobRepository?: TranscriptionJobRepository,
    @Optional() @Inject(ConsultationRepository) private readonly consultationRepository?: ConsultationRepository,
  ) {
    super(eventEmitter, clsService, ResourceType.WorkflowDefinition);
  }

  async startRun(definitionId: string, dto: StartSandboxRunRequest): Promise<SandboxRunResponse> {
    const tenantId = this.requireTenantId();

    const compiled = await this.workflowDefinitionService.getCompiledConfigForSandboxRun(definitionId);
    const basePayload = await this.resolvePayload(tenantId, dto);
    // TASK-1036 OD-15 — every ownership check BEFORE anything is written (404-over-403).
    const attachments = dto.attachments?.length
      ? await this.resolveAttachments(
          tenantId,
          dto.attachments.map((a) => a.mediaId),
        )
      : undefined;
    const recordingJob = dto.recording ? await this.resolveRecordingSession(tenantId, definitionId, dto.recording.sttSessionId) : undefined;
    // TASK-1038 (F1) — attachments and the recording go where the INPUT SHAPE declares them (a
    // 400 when it declares nowhere), still BEFORE anything is written.
    const payload = sandboxRunPayload(compiled.compiledConfig, basePayload, attachments, dto.recording);

    if (!this.s3Service) {
      throw new ArgumentInvalidException('Sandbox runs are unavailable: no claim-check storage backend is configured.');
    }
    const configRef = await mintCompiledConfigClaimCheckRef(compiled.compiledConfig, CLAIM_CHECK_BUCKET, (b, key, data, contentType) =>
      this.s3Service!.putFile(b, key, data, contentType),
    );

    const runId = generateId();
    const sessionId = interpreterSessionId(runId);

    // A recording binds to a SANDBOX consultation the run owns: the session's own, when it is
    // already one of this workflow's sandbox consultations, else a new one.
    const subject: StartWorkflowRunSubject | undefined = recordingJob
      ? { consultationId: await this.bindSandboxConsultation(tenantId, definitionId, runId, recordingJob), userId: this.requestUserId ?? undefined }
      : undefined;

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
      // The consultation this run may read (`internal/consultations/:id/read` checks it).
      ...(subject ? { metaData: { consultationId: subject.consultationId } } : {}),
    });

    let started: Awaited<ReturnType<HarnessGatewayService['startWorkflowRun']>>;
    try {
      started = await this.harnessGateway.startWorkflowRun({
        runId,
        sessionId,
        workflowVersionId: compiled.workflowVersionId,
        tenantId,
        configRef,
        sandbox: true,
        payload,
        ...(subject ? { subject } : {}),
      });
    } catch (error) {
      // The anchor row exists, so a start that never reached the harness must not leave it RUNNING.
      // Only a code is recorded — the error's message is never persisted.
      await this.workflowRunService
        .recordRunFinished({ tenantId, sessionId, runId, status: 'FAILED', firstErrorCode: 'RUN_START_FAILED' })
        // swallow-ok: the start error below is the one the caller must see.
        .catch(() => undefined);
      throw error;
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: definitionId,
      data: {
        action: 'sandboxRun',
        runId,
        fixtureId: dto.fixtureId ?? null,
        attachmentCount: attachments?.length ?? 0,
        sttSessionId: dto.recording?.sttSessionId ?? null,
        consultationId: subject?.consultationId ?? null,
      },
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

  /**
   * TASK-1036 OD-15 — tenant media by reference. Unknown or foreign → 404; a MIME type outside the
   * attachment allow-list (`CONTEXT_ATTACHMENT_MIME_TYPES`) → 400. Never the bytes or the storage URI.
   */
  private async resolveAttachments(
    tenantId: string,
    mediaIds: string[],
  ): Promise<SandboxMediaReference[]> {
    if (!this.mediaRepository) throw new ArgumentInvalidException('Sandbox attachments are unavailable: no media repository is configured.');
    const out: SandboxMediaReference[] = [];
    for (const mediaId of mediaIds) {
      const media = await this.mediaRepository.findByIdOrNull(mediaId);
      if (!media || media.tenantId !== tenantId) throw new NotFoundException(`Media '${mediaId}' not found.`);
      const mime = normalizeContextMimeType(media.mimeType ?? '');
      if (!(CONTEXT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime)) {
        throw new BadRequestException({
          code: 'SANDBOX_ATTACHMENT_MIME_UNSUPPORTED',
          message: `Media '${mediaId}' is ${mime || 'of no type'}; attachments must be one of ${CONTEXT_ATTACHMENT_MIME_TYPES.join(', ')}.`,
        });
      }
      out.push({ mediaId, mime, name: media.name, size: media.size });
    }
    return out;
  }

  /**
   * TASK-1036 OD-15 — the STT streaming session's job row a sandbox run may record on.
   *
   * TASK-1038 E2 (fix 12) — the session must be the CALLER's, LIVE, and (if already bound) bound
   * to a sandbox consultation of THIS definition. Every check runs before anything is written, so
   * a refused request never re-binds a job the caller did not create:
   *  - of THIS tenant AND created by the requesting principal (`createdBy`) — else 404, the same
   *    answer as an unknown session (404-over-403; a colleague's live clinical audio is not the
   *    caller's to pull into a test run);
   *  - live (QUEUED / PROCESSING, not completed) — else 409 `SANDBOX_RECORDING_NOT_LIVE`;
   *  - unbound, or bound to a sandbox consultation created for `definitionId` — else 409
   *    `SANDBOX_RECORDING_BOUND_ELSEWHERE` (a clinical consultation, or another workflow's sandbox).
   */
  private async resolveRecordingSession(tenantId: string, definitionId: string, sttSessionId: string): Promise<TranscriptionJobEntity> {
    if (!this.transcriptionJobRepository || !this.consultationRepository) {
      throw new ArgumentInvalidException('Sandbox recordings are unavailable: the STT session store is not configured.');
    }
    const [job] = await this.transcriptionJobRepository.findAll({
      filters: { tenantId, streamSessionId: sttSessionId, jobType: TranscriptionJobType.STREAMING },
    });
    const requester = this.requestUserId;
    if (!job || job.tenantId !== tenantId || !requester || !job.createdBy || job.createdBy !== requester) {
      throw new NotFoundException(`STT session '${sttSessionId}' not found.`);
    }
    if (!LIVE_RECORDING_STATUSES.has(String(job.status)) || job.completedAt) {
      throw new ConflictException({
        code: 'SANDBOX_RECORDING_NOT_LIVE',
        message: `STT session '${sttSessionId}' has ended; a sandbox run records on a live session.`,
      });
    }
    if (job.consultationId) {
      const bound = await this.consultationRepository.findByIdOrNull(job.consultationId);
      if (!bound || bound.tenantId !== tenantId) throw new NotFoundException(`STT session '${sttSessionId}' not found.`);
      if (sandboxDefinitionOf(bound.metadata) !== definitionId) {
        throw new ConflictException({
          code: 'SANDBOX_RECORDING_BOUND_ELSEWHERE',
          message: `STT session '${sttSessionId}' is bound to another consultation; a sandbox run records on its own session.`,
        });
      }
    }
    return job;
  }

  /**
   * The sandbox consultation a recording runs against: the one the session is already bound to (a
   * sandbox consultation, checked above), else a new one — the requesting admin as clinician, a
   * synthetic patient reference, `metadata.sandbox` naming the workflow and session — with the
   * session's job row re-bound to it.
   */
  private async bindSandboxConsultation(tenantId: string, definitionId: string, runId: string, job: TranscriptionJobEntity): Promise<string> {
    if (job.consultationId) return job.consultationId;
    const doctorId = this.requestUserId;
    if (!doctorId) throw new ArgumentInvalidException('A sandbox recording needs a signed-in user to act as the clinician.');
    const consultation = ConsultationFactory.CreateConsultation({
      tenantId,
      doctorId,
      patientId: `sandbox:${runId}`,
      appointmentDate: new Date(),
      metadata: { sandbox: { workflowDefinitionId: definitionId, runId, sttSessionId: job.streamSessionId ?? null } },
      createdBy: doctorId,
    });
    const saved = await this.consultationRepository!.create(consultation);
    job.consultationId = saved.id;
    await this.transcriptionJobRepository!.update(job.id, job);
    return saved.id;
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

/** The workflow a sandbox consultation was created for, or `null` for a clinical consultation. */
function sandboxDefinitionOf(metadata: unknown): string | null {
  const sandbox = typeof metadata === 'object' && metadata !== null ? (metadata as Record<string, unknown>).sandbox : undefined;
  const definitionId = typeof sandbox === 'object' && sandbox !== null ? (sandbox as Record<string, unknown>).workflowDefinitionId : undefined;
  return typeof definitionId === 'string' && definitionId.length > 0 ? definitionId : null;
}
