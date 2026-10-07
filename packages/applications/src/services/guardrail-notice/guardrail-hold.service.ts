import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationProcessing,
  ConsultationRepository,
  ConsultationStatus,
  CoreUnitOfWorkService,
  GuardrailNoticeEntityMapper,
  GuardrailNoticeFactory,
  GuardrailNoticeRepository,
  ResourceType,
  SysEventType,
  type GuardrailNoticeEntity,
  type JsonValue,
} from '@arcaai/domains';
import { EGRESS_REDACTION_UNAVAILABLE_REASON, GUARDRAIL_HOLD_REASON, type GuardrailNotice } from '@arcaai/types';
import { BaseService } from '../../common';
import { createWorkerSession } from '../../common/worker-session';
import { IActiveUserContext } from '../../interfaces';
import { IConsultationLifecycleService, IConsultationLifecycleServiceToken } from '../consultation/lifecycle/IConsultationLifecycleService';
import { ConsultationLifecycleEventPublisher } from '../consultation/lifecycle/lifecycle-event.publisher';
import { directionToRow, noticeSeverity, noticeTypeToRow } from './guardrail-wire';

/** DI token of {@link GuardrailHoldService} (a `@Global()` provider, see `GuardrailHoldServiceModule`). */
export const IGuardrailHoldService = Symbol('IGuardrailHoldService');

/** A consultation in one of these states is past its visit: a block is recorded, never held. */
const NOT_HOLDABLE: ReadonlySet<string> = new Set([
  ConsultationStatus.APPROVED,
  ConsultationStatus.CLOSED_COMPLETE,
  ConsultationStatus.CLOSED_INCOMPLETE,
]);

/** The `processingReason` a blocked notice holds the consultation with. */
export function guardrailHoldReasonOf(notice: Pick<GuardrailNotice, 'messageKey'>): string {
  return notice.messageKey === 'guardrail.blocked.redaction_unavailable' ? EGRESS_REDACTION_UNAVAILABLE_REASON : GUARDRAIL_HOLD_REASON;
}

/**
 * The stored row of a `GuardrailNotice` v1, under the notice's OWN id. Guardrail mints it
 * deterministically (sha256(tenantId|dedupeKey)); TEXT and the harness mint theirs. The id is also
 * the dedupe key, so a re-raise is a no-op and two different ids are never collapsed.
 */
export function guardrailNoticeRow(tenantId: string, notice: GuardrailNotice): GuardrailNoticeEntity {
  const draft = GuardrailNoticeFactory.CreateGuardrailNotice({
    tenantId,
    consultationId: notice.consultationId ?? null,
    runId: notice.runId ?? null,
    nodeId: notice.nodeId ?? null,
    type: noticeTypeToRow(notice.type),
    direction: directionToRow(notice.direction),
    action: notice.action,
    checks: notice.checks.map((check) => ({ ...check })) as unknown as JsonValue,
    itemIds: [...notice.itemIds],
    messageKey: notice.messageKey,
    severity: noticeSeverity(notice.checks),
    requiresAcknowledgement: notice.requiresAcknowledgement,
    resumable: notice.resumable,
    policyVersion: notice.policyVersion,
    dedupeKey: notice.noticeId,
    createdAt: new Date(notice.occurredAt),
  });
  // TODO(TASK-1050 W0 follow-up): `GuardrailNoticeFactory` mints its own id; the notice id is the
  // producer's, so the row is re-read through the mapper with it.
  const mapper = GuardrailNoticeEntityMapper.getInstance();
  return mapper.toDomainEntity({ ...(mapper.toPersistence(draft) as object), id: notice.noticeId } as never);
}

/** A hold written inside a transaction, still to be announced after the commit. */
export interface GuardrailHoldApplied {
  consultationId: string;
  noticeId: string;
  reason: string;
  /** The consultation was RECORDING: capture is paused after the commit. */
  pause: boolean;
  subject: {
    id: string;
    tenantId: string;
    status: string;
    processing: string;
    processingReason: string;
    closedReason: string | null;
    currentEncounterSeq: number;
    version: number;
  };
}

/** What {@link GuardrailHoldService.enterGuardrailHold} entered. */
export interface GuardrailHoldEntry {
  consultationId: string;
  noticeId: string;
  reason: string;
  paused: boolean;
}

/**
 * TASK-1050 W2e — entering a consultation's guardrail HOLD (README §9.7.5, §9.8.1): `processing`
 * AWAITING_REVIEW with reason GUARDRAIL_HOLD (EGRESS_REDACTION_UNAVAILABLE for the egress privacy
 * hold), capture paused, and a state-only lifecycle event carrying the notice id as a pointer.
 *
 * Two doors, one rule:
 *  - {@link enterGuardrailHold} — a caller that holds a BLOCKED notice no evaluation record carries:
 *    TEXT's redaction hold (guardrail's inbound screen is down, so nothing was evaluated), and a
 *    harness run that paused on a block before its evaluation drained (the run watcher). It writes
 *    the notice and the hold in its own transaction.
 *  - {@link holdInTransaction} + {@link announce} — the evaluation ingest, which writes the notice
 *    itself inside its batch transaction.
 *
 * A hold is entered only when its notice is NEW: the same notice id arriving twice (the run
 * watcher, then the drained evaluation) is a no-op, and so is a re-raise of a notice the clinician
 * already resolved. An approved or closed consultation is never held (logged, not thrown).
 */
@Injectable()
export class GuardrailHoldService extends BaseService {
  private readonly logger = new Logger(GuardrailHoldService.name);

  constructor(
    private readonly consultations: ConsultationRepository,
    private readonly notices: GuardrailNoticeRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Unwired ⇒ the writes run in sequence (unit fixtures).
    @Optional() @Inject(CoreUnitOfWorkService) private readonly unitOfWork?: Pick<CoreUnitOfWorkService, 'runInTransaction'>,
    @Optional() @Inject(ConsultationLifecycleEventPublisher) private readonly lifecycleEvents?: Pick<ConsultationLifecycleEventPublisher, 'publish'>,
    // `pause` stops capture on a held RECORDING consultation. Unwired ⇒ processing still holds it.
    @Optional() @Inject(IConsultationLifecycleServiceToken) private readonly lifecycle?: Pick<IConsultationLifecycleService, 'pause'>,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  /**
   * Store the BLOCKED notice (by its id) and enter the consultation's hold, then pause capture and
   * announce it. Runs under a CLS context pinned to `tenantId`. Idempotent on the notice id. Never
   * throws: a refusal or a failure is logged and answers `null`.
   */
  async enterGuardrailHold(tenantId: string, consultationId: string, notice: GuardrailNotice): Promise<GuardrailHoldEntry | null> {
    if (notice.type !== 'guardrail.blocked') {
      this.logger.warn({
        message: 'Only a blocked notice holds a consultation — ignored',
        consultationId,
        noticeId: notice.noticeId,
        type: notice.type,
      });
      return null;
    }
    try {
      return await this.clsService.run(async () => {
        this.clsService.set('tenantId', tenantId);
        this.clsService.set('user', createWorkerSession({ tenantId, kind: 'guardrail-hold' }));
        const write = async (tx?: unknown): Promise<GuardrailHoldApplied | null> => {
          const { created } = await this.notices.upsertByDedupeKey(guardrailNoticeRow(tenantId, notice), tx);
          if (!created) return null;
          return this.holdInTransaction(tenantId, consultationId, notice.noticeId, guardrailHoldReasonOf(notice), tx);
        };
        const applied = this.unitOfWork ? await this.unitOfWork.runInTransaction((tx) => write(tx)) : await write();
        if (!applied) return null;
        const { paused } = await this.announce(applied);
        return { consultationId, noticeId: applied.noticeId, reason: applied.reason, paused };
      });
    } catch (error) {
      this.logger.warn({
        message: 'Guardrail hold could not be entered',
        consultationId,
        noticeId: notice.noticeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Inside the caller's transaction: set `processing` AWAITING_REVIEW with the hold reason. `null`
   * (logged) for an unknown, foreign, approved or closed consultation.
   */
  async holdInTransaction(
    tenantId: string,
    consultationId: string,
    noticeId: string,
    reason: string,
    tx?: unknown,
  ): Promise<GuardrailHoldApplied | null> {
    const consultation = await this.consultations.findByIdOrNull(consultationId);
    if (!consultation || consultation.tenantId !== tenantId) {
      this.logger.warn({ message: 'Guardrail hold refused — no such consultation in this tenant', consultationId, noticeId });
      return null;
    }
    if (NOT_HOLDABLE.has(String(consultation.status))) {
      this.logger.log({
        message: 'Guardrail hold not entered — the consultation is approved or closed',
        consultationId,
        noticeId,
        status: consultation.status,
      });
      return null;
    }
    await this.consultations.setProcessing(consultationId, ConsultationProcessing.AWAITING_REVIEW, { reason }, tx);
    return {
      consultationId,
      noticeId,
      reason,
      pause: String(consultation.status) === ConsultationStatus.RECORDING,
      subject: {
        id: consultation.id,
        tenantId: consultation.tenantId,
        status: String(consultation.status),
        processing: ConsultationProcessing.AWAITING_REVIEW,
        processingReason: reason,
        closedReason: consultation.closedReason ?? null,
        currentEncounterSeq: consultation.currentEncounterSeq,
        version: consultation.version,
      },
    };
  }

  /** After the commit: capture stops and clients learn of the hold. Best-effort — the hold stands. */
  async announce(hold: GuardrailHoldApplied): Promise<{ paused: boolean }> {
    let status = hold.subject.status;
    let version = hold.subject.version;
    let paused = false;
    if (hold.pause && this.lifecycle) {
      try {
        const state = (await this.lifecycle.pause(hold.consultationId, { reason: 'guardrail_hold' })) as
          { status?: string; version?: number } | undefined;
        status = state?.status ?? ConsultationStatus.PAUSED;
        version = state?.version ?? version;
        paused = true;
      } catch (error) {
        this.logger.warn({
          message: 'Guardrail hold entered, but capture could not be paused',
          consultationId: hold.consultationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await this.lifecycleEvents?.publish({ ...hold.subject, status, version }, 'processing_changed', { noticeId: hold.noticeId });
    } catch (error) {
      this.logger.warn({
        message: 'Guardrail hold lifecycle event not published (the hold stands)',
        consultationId: hold.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: hold.consultationId,
      resourceType: ResourceType.Consultation,
      data: { action: 'guardrail_hold_entered', noticeId: hold.noticeId, processingReason: hold.reason },
    });
    return { paused };
  }
}
