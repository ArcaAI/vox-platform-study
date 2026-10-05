import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import type { CaptureState, StopResult } from '@arcaai/types';
import {
  ConsultationClosedReason,
  ConsultationEncounterRepository,
  ConsultationEntity,
  ConsultationProcessing,
  ConsultationRepository,
  ConsultationStatus,
  ContextItemRepository,
  TranscriptionJobRepository,
  TranscriptionJobType,
} from '@arcaai/domains';
import { IActiveUserContext } from '../../../interfaces';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { StreamingAudioBridgeService } from '../../stt/streaming/streamingAudioBridge.service';
import { StreamingSessionService } from '../../stt/streaming/streamingSession.service';
import type { IStreamingSessionService } from '../../stt/streaming/IStreamingSessionService';
import { ConsultationDtoMapper } from '../consultation/consultation.dto.mapper';
import type { ConsultationResponse } from '../consultation/dto/consultation.response';
import { STT_SESSION_SUPERSEDED_EVENT, type SttSessionSupersededEvent } from '../consultation/stt-session-superseded.event';
import { ConsultationPipelineEvent, type EncounterStoppedPayload } from '../events/consultation.events';
import { ITranscriptRecordService, ITranscriptRecordServiceToken } from '../transcript-record/ITranscriptRecordService';
import { toCaptureState } from './capture-state';
import { ConsultationApprovalService, type ApproveOptions } from './consultation-approval.service';
import { ConsultationLifecycleGate } from './consultation-lifecycle.gate';
import { IConsultationLifecycleService, type ClinicalCaller } from './IConsultationLifecycleService';
import { LifecycleConflictCode, applyLifecycleTransition, lifecycleConflict } from './lifecycle-errors';
import { ConsultationLifecycleEventPublisher, type LifecycleSubject } from './lifecycle-event.publisher';

/** Tenant policy: may an approved, closed consultation be reopened. */
export const CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_KEY = 'consultation.reopen.allowClosedComplete';
/** How long `stop` holds the request for the final transcript. */
export const CONSULTATION_STOP_FINAL_TRANSCRIPT_TIMEOUT_KEY = 'consultation.stop.finalTranscriptTimeoutSeconds';

/**
 * Used only when the settings service is unwired or cannot answer — the same value the
 * descriptor declares as its default.
 */
const STOP_FINAL_TRANSCRIPT_TIMEOUT_FALLBACK_SECONDS = 30;

type ControlAction = 'finalize' | 'pause' | 'resume';

/**
 * The consultation lifecycle commands — WHERE the consultation is (`status`, the matrix in
 * `ConsultationEntity`) — plus the transcript hand-off on `stop`.
 *
 * Status transitions are compare-and-set writes (`updateWithVersion`): on the If-Match routes
 * (close / reopen) against the client's version, on the capture commands against the version
 * just read. `processing` and `lastActivityAt` move through the gate's no-version-bump writers.
 * Every applied change emits one lifecycle event (in-process, Redis frame, sys-event); a
 * self-transition is an idempotent no-op that writes and emits nothing.
 *
 * STT sessions bound to a consultation are its open STREAMING `TranscriptionJob` rows; control
 * commands (pause / resume / finalize) go to the ones apps/stt reports as live, through the same
 * Redis control stream the WS gateway uses, so the server is authoritative across pods.
 */
@Injectable()
export class ConsultationLifecycleService extends IConsultationLifecycleService {
  private readonly logger = new Logger(ConsultationLifecycleService.name);

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly encounterRepository: ConsultationEncounterRepository,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly approvals: ConsultationApprovalService,
    private readonly gate: ConsultationLifecycleGate,
    private readonly events: ConsultationLifecycleEventPublisher,
    private readonly eventEmitter: EventEmitter2,
    private readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(TranscriptionJobRepository)
    private readonly transcriptionJobs?: Pick<TranscriptionJobRepository, 'findAll'>,
    @Optional() @Inject(StreamingSessionService)
    private readonly streamingSessions?: Pick<IStreamingSessionService, 'getSessionStatus'>,
    @Optional() private readonly audioBridge?: Pick<StreamingAudioBridgeService, 'writeControlCommand'>,
    @Optional() @Inject(ITranscriptRecordServiceToken) private readonly transcriptRecord?: Pick<ITranscriptRecordService, 'awaitFinal'>,
    @Optional() private readonly effectiveSettings?: Pick<EffectiveSettingsService, 'resolveEffective'>,
  ) {
    super();
  }

  // ── start / pause ──────────────────────────────────────────────────────────────────────────

  async start(consultationId: string, options: { sttSessionId?: string; supersedeByDurableBinding?: boolean } = {}): Promise<CaptureState> {
    const consultation = await this.load(consultationId);
    if (!consultation.isRecordable) {
      throw lifecycleConflict(
        LifecycleConflictCode.CONSULTATION_NOT_RECORDABLE,
        `Consultation ${consultationId} is ${consultation.status} and cannot be recorded. Reopen it, or open a new consultation.`,
        { status: consultation.status },
      );
    }
    if (options.sttSessionId) {
      await this.assertSttSessionLive(consultation, options.sttSessionId);
    }

    const from = consultation.status;
    const changed = applyLifecycleTransition(consultation, ConsultationStatus.RECORDING, this.actor(), 'start');
    const current = changed ? await this.persist(consultation, consultation.version) : consultation;
    await this.consultationRepository.touchActivity(consultationId);

    if (changed && from === ConsultationStatus.PAUSED) {
      await this.sendControl(await this.liveBoundSessions(consultation), 'resume', consultationId);
    }
    if (options.sttSessionId && options.supersedeByDurableBinding) {
      await this.supersedeByDurableBinding(consultation, options.sttSessionId);
    }
    if (changed) {
      await this.events.publish(current, 'started');
    }
    return toCaptureState(current, options.sttSessionId);
  }

  async pause(consultationId: string, options: { reason?: 'user' | 'stale_recording' } = {}): Promise<CaptureState> {
    const consultation = await this.load(consultationId, { allowTenantless: options.reason === 'stale_recording' });
    const changed = applyLifecycleTransition(consultation, ConsultationStatus.PAUSED, this.actor(), options.reason ?? 'user');
    if (!changed) return toCaptureState(consultation);

    const current = await this.persist(consultation, consultation.version);
    await this.sendControl(await this.liveBoundSessions(consultation), 'pause', consultationId);
    await this.events.publish(current, 'paused');
    return toCaptureState(current);
  }

  // ── stop ───────────────────────────────────────────────────────────────────────────────────

  /**
   * RECORDING / PAUSED → STOPPED with processing FINALIZING_TRANSCRIPT; finalize every live bound
   * STT session; hold the request (up to the tenant's timeout) for the final transcript. On
   * `complete`, processing returns to what it was and `EncounterStopped` + `transcript_final`
   * are emitted. On `pending` the transcript-record service completes the stop when the final
   * transcript lands. Idempotent on STOPPED (D-28): the current state, nothing written.
   */
  async stop(consultationId: string, options: { waitForFinal?: boolean } = {}): Promise<StopResult> {
    const consultation = await this.load(consultationId);
    if (consultation.status === ConsultationStatus.STOPPED) {
      const finalizing = consultation.processing === ConsultationProcessing.FINALIZING_TRANSCRIPT;
      return this.stopResult(consultation, finalizing ? 'pending' : 'complete', consultation.processing);
    }

    applyLifecycleTransition(consultation, ConsultationStatus.STOPPED, this.actor(), 'stop');
    const prior =
      consultation.processing === ConsultationProcessing.FINALIZING_TRANSCRIPT ? (consultation.processingPrior ?? null) : consultation.processing;
    consultation.setProcessing(ConsultationProcessing.FINALIZING_TRANSCRIPT);
    consultation.processingPrior = prior;
    const stopped = await this.persist(consultation, consultation.version);
    await this.events.publish(stopped, 'stopped');

    const sessions = await this.liveBoundSessions(consultation);
    await this.sendControl(sessions, 'finalize', consultationId);

    let state: 'complete' | 'pending';
    if (sessions.length === 0) {
      state = 'complete';
    } else if (options.waitForFinal === false || !this.transcriptRecord) {
      state = 'pending';
    } else {
      const timeoutMs = (await this.finalTranscriptTimeoutSeconds(consultation)) * 1000;
      state = await this.transcriptRecord.awaitFinal(consultationId, sessions, timeoutMs);
    }

    if (state === 'pending') {
      return this.stopResult(stopped, 'pending', ConsultationProcessing.FINALIZING_TRANSCRIPT);
    }

    const restored = prior ?? ConsultationProcessing.IDLE;
    await this.consultationRepository.setProcessing(consultationId, restored, { prior: null });
    const payload: EncounterStoppedPayload = {
      consultationId,
      tenantId: stopped.tenantId,
      userId: this.requestUserId(),
      timestamp: new Date().toISOString(),
      encounterSeq: stopped.currentEncounterSeq,
    };
    this.eventEmitter.emit(ConsultationPipelineEvent.EncounterStopped, payload);
    await this.events.publish(this.subject(stopped, { processing: restored, processingReason: null }), 'transcript_final');
    return this.stopResult(stopped, 'complete', restored);
  }

  // ── approve / close / reopen ───────────────────────────────────────────────────────────────

  approve(consultationId: string, options: ApproveOptions): Promise<ConsultationResponse> {
    return this.approvals.approve(consultationId, options);
  }

  /**
   * CLOSED_COMPLETE when APPROVED (closedReason APPROVED), else CLOSED_INCOMPLETE (AUTO for the
   * sweep, MANUAL otherwise). A capturing consultation is flushed first (finalize control). The
   * current encounter ends. Idempotent on a closed consultation (D-29).
   */
  async close(
    consultationId: string,
    options: { expectedVersion?: number; clinicianUserId?: string; caller?: ClinicalCaller; auto?: boolean } = {},
  ): Promise<ConsultationResponse> {
    const consultation = await this.load(consultationId, { allowTenantless: options.auto === true });
    if (consultation.isClosed) {
      return ConsultationDtoMapper.toResponseWithContext(consultation);
    }

    if (consultation.status === ConsultationStatus.RECORDING || consultation.status === ConsultationStatus.PAUSED) {
      await this.sendControl(await this.liveBoundSessions(consultation), 'finalize', consultationId);
    }

    const actor = options.caller?.userId ?? options.clinicianUserId ?? this.actor();
    const target = consultation.status === ConsultationStatus.APPROVED ? ConsultationStatus.CLOSED_COMPLETE : ConsultationStatus.CLOSED_INCOMPLETE;
    applyLifecycleTransition(consultation, target, actor, options.auto ? 'auto_close' : 'close', {
      closedReason: options.auto ? ConsultationClosedReason.AUTO : ConsultationClosedReason.MANUAL,
    });
    if (!options.auto) consultation.updatedBy = actor;

    const closed = await this.persist(consultation, options.expectedVersion ?? consultation.version);
    try {
      await this.encounterRepository.endEncounter(consultationId, closed.currentEncounterSeq, { endedAt: closed.closedAt ?? new Date() });
    } catch (error) {
      this.logger.warn({
        message: 'Closing the current encounter failed (the consultation close stands)',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await this.events.publish(closed, 'closed', { userId: actor });
    return ConsultationDtoMapper.toResponseWithContext(closed);
  }

  /**
   * CLOSED_INCOMPLETE → OPEN always; CLOSED_COMPLETE → OPEN only under the tenant's
   * `consultation.reopen.allowClosedComplete`. Clears `approvedAt`; `reopenCount` increments.
   */
  async reopen(consultationId: string, options: { expectedVersion: number; reason?: string }): Promise<ConsultationResponse> {
    const consultation = await this.load(consultationId);
    if (!consultation.isClosed) {
      throw lifecycleConflict(LifecycleConflictCode.TRANSITION_ILLEGAL, `Only a closed consultation can be reopened (it is ${consultation.status}).`, {
        from: consultation.status,
        to: ConsultationStatus.OPEN,
      });
    }
    const allowClosedCompleteReopen =
      consultation.status === ConsultationStatus.CLOSED_COMPLETE ? await this.allowClosedCompleteReopen(consultation) : false;

    const actor = this.actor();
    applyLifecycleTransition(consultation, ConsultationStatus.OPEN, actor, 'reopen', { allowClosedCompleteReopen });
    consultation.approvedAt = null;
    consultation.updatedBy = actor;

    const reopened = await this.persist(consultation, options.expectedVersion);
    await this.events.publish(reopened, 'reopened');
    return ConsultationDtoMapper.toResponseWithContext(reopened);
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────

  private async load(consultationId: string, options: { allowTenantless?: boolean } = {}): Promise<ConsultationEntity> {
    const tenantId = this.clsService.get('tenantId') || null;
    if (!tenantId && !options.allowTenantless) {
      throw new BadRequestException('Tenant ID is required');
    }
    const consultation = await this.consultationRepository.findByIdOrNull(consultationId);
    if (!consultation || (tenantId && consultation.tenantId !== tenantId)) {
      throw new NotFoundException('Consultation not found');
    }
    return consultation;
  }

  private persist(consultation: ConsultationEntity, expectedVersion: number): Promise<ConsultationEntity> {
    return this.consultationRepository.updateWithVersion(consultation.id, consultation, expectedVersion);
  }

  private requestUserId(): string | undefined {
    return this.clsService.get('user')?.id ?? undefined;
  }

  private actor(): string {
    return this.requestUserId() ?? 'system';
  }

  private subject(entity: ConsultationEntity, overrides: Partial<LifecycleSubject> = {}): LifecycleSubject {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      status: entity.status,
      processing: entity.processing,
      processingReason: entity.processingReason,
      closedReason: entity.closedReason,
      currentEncounterSeq: entity.currentEncounterSeq,
      version: entity.version,
      ...overrides,
    };
  }

  private async stopResult(entity: ConsultationEntity, state: 'complete' | 'pending', processing: ConsultationProcessing): Promise<StopResult> {
    let contextItemId: string | null = null;
    let versionNumber: number | null = null;
    let segmentCount = entity.segmentSeqHead;
    if (state === 'complete') {
      try {
        const full = await this.contextItemRepository.findFullTranscript(entity.id);
        if (full) {
          contextItemId = full.id;
          versionNumber = Number(full.currentVersionNumber ?? 1);
          const counted = (full.metaData as { segmentCount?: unknown } | null | undefined)?.segmentCount;
          if (typeof counted === 'number') segmentCount = counted;
        }
      } catch (error) {
        this.logger.warn({
          message: 'Full transcript unreadable while answering stop',
          consultationId: entity.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ...toCaptureState(entity),
      processing,
      finalTranscript: { state, contextItemId, versionNumber, segmentCount, lastSegmentSeq: entity.segmentSeqHead },
    } as StopResult;
  }

  /** Open STREAMING bindings of the consultation whose session apps/stt reports live (unknown ⇒ kept). */
  private async liveBoundSessions(consultation: ConsultationEntity): Promise<string[]> {
    if (!this.transcriptionJobs) return [];
    let rows: Array<{ streamSessionId?: string | null }>;
    try {
      rows = (await this.transcriptionJobs.findAll({
        // STREAMING rows carry no transcript ciphertext, so this read decrypts nothing.
        filters: { consultationId: consultation.id, jobType: TranscriptionJobType.STREAMING, completedAt: null } as never,
        sort: [{ createdAt: 'desc' }],
      })) as Array<{ streamSessionId?: string | null }>;
    } catch (error) {
      this.logger.warn({
        message: 'Could not read the STT sessions bound to the consultation — no control sent',
        consultationId: consultation.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    const ids = [...new Set(rows.map((row) => row.streamSessionId).filter((id): id is string => !!id))];
    if (!this.streamingSessions) return ids;
    const streamingSessions = this.streamingSessions;
    const live = await Promise.all(
      ids.map(async (id) => {
        try {
          return (await streamingSessions.getSessionStatus(id, consultation.tenantId))?.status === 'active' ? id : null;
        } catch {
          return id;
        }
      }),
    );
    return live.filter((id): id is string => id !== null);
  }

  private async sendControl(sessionIds: string[], action: ControlAction, consultationId: string): Promise<void> {
    if (!this.audioBridge) return;
    for (const sessionId of sessionIds) {
      try {
        await this.audioBridge.writeControlCommand(sessionId, action);
      } catch (error) {
        this.logger.warn({
          message: 'STT control command not delivered (the lifecycle change stands)',
          consultationId,
          sessionId,
          action,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Refuse (409) a session apps/stt reports as not active. A lookup that FAILS proceeds: this
   * refuses a session it knows is stale, never one it merely could not check.
   */
  private async assertSttSessionLive(consultation: ConsultationEntity, sttSessionId: string): Promise<void> {
    if (!this.streamingSessions) return;
    let status: string;
    try {
      status = (await this.streamingSessions.getSessionStatus(sttSessionId, consultation.tenantId))?.status ?? 'unknown';
    } catch (error) {
      this.logger.warn({
        message: 'start could not ask apps/stt whether the STT session is live — binding it unchecked',
        consultationId: consultation.id,
        sttSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (status === 'active') return;
    throw lifecycleConflict(
      LifecycleConflictCode.STT_SESSION_NOT_ACTIVE,
      `STT streaming session ${sttSessionId} is not active (${status}); it was not bound to this recording. Create a new STT streaming session and start with it.`,
      { sttSessionId, sttSessionStatus: status },
    );
  }

  /**
   * One live STT session per consultation, last writer wins: every OLDER live binding is
   * superseded (its listener finalizes it). Never throws.
   */
  private async supersedeByDurableBinding(consultation: ConsultationEntity, sttSessionId: string): Promise<void> {
    if (!this.transcriptionJobs) return;
    let rows: Array<{ streamSessionId?: string | null; createdAt: Date }>;
    try {
      rows = (await this.transcriptionJobs.findAll({
        filters: { consultationId: consultation.id, jobType: TranscriptionJobType.STREAMING, completedAt: null } as never,
        sort: [{ createdAt: 'desc' }],
      })) as Array<{ streamSessionId?: string | null; createdAt: Date }>;
    } catch {
      return;
    }
    const own = rows.find((row) => row.streamSessionId === sttSessionId);
    const older = rows.filter((row) => row.streamSessionId && row.streamSessionId !== sttSessionId && (!own || row.createdAt <= own.createdAt));
    const live = new Set(await this.liveBoundSessions(consultation));
    for (const row of older) {
      const supersededSessionId = row.streamSessionId as string;
      if (!live.has(supersededSessionId)) continue;
      const event: SttSessionSupersededEvent = {
        tenantId: consultation.tenantId,
        consultationId: consultation.id,
        supersededSessionId,
        supersedingSessionId: sttSessionId,
      };
      try {
        this.eventEmitter.emit(STT_SESSION_SUPERSEDED_EVENT, event);
      } catch (error) {
        this.logger.warn({
          message: 'STT session superseded event not delivered — the old session ends by its own idle reaper',
          ...event,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async allowClosedCompleteReopen(consultation: ConsultationEntity): Promise<boolean> {
    const value = await this.readSetting(CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_KEY, consultation);
    return value === true;
  }

  private async finalTranscriptTimeoutSeconds(consultation: ConsultationEntity): Promise<number> {
    const value = await this.readSetting(CONSULTATION_STOP_FINAL_TRANSCRIPT_TIMEOUT_KEY, consultation);
    return typeof value === 'number' && value > 0 ? value : STOP_FINAL_TRANSCRIPT_TIMEOUT_FALLBACK_SECONDS;
  }

  private async readSetting(key: string, consultation: ConsultationEntity): Promise<unknown> {
    if (!this.effectiveSettings) return undefined;
    try {
      const result = await this.effectiveSettings.resolveEffective(key, {
        tenantId: consultation.tenantId,
        departmentId: consultation.departmentId ?? null,
        doctorId: consultation.doctorId,
      });
      return result.value;
    } catch (error) {
      this.logger.warn({
        message: 'Lifecycle setting unresolved — using the fail-safe value',
        key,
        consultationId: consultation.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}
