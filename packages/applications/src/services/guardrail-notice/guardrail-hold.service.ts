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
  GuardrailNoticeStatus,
  GuardrailNoticeType,
  ResourceType,
  SysEventType,
  type GuardrailNoticeEntity,
  type JsonValue,
} from '@arcaai/domains';
import { EGRESS_REDACTION_UNAVAILABLE_REASON, GUARDRAIL_HOLD_REASON, isGuardrailHoldReason, type GuardrailNotice } from '@arcaai/types';
import { BaseService } from '../../common';
import { createWorkerSession } from '../../common/worker-session';
import { IActiveUserContext } from '../../interfaces';
import { readGoverningEngineMarker } from '../consultation/governing-engine';
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

/**
 * TASK-1059 — the run a block came from is OVER when the consultation's governing marker names another
 * run (it was superseded, e.g. by a resume) or stamps this one with a terminal `runStatus`. A hold then
 * has nothing paused behind it and would strand the consultation. No marker (no tenant graph governs)
 * or no run id (a live-summary tick, a direct generation) cannot be judged and is never "over".
 */
export function guardrailRunIsOver(metadata: unknown, runId: string | null | undefined): boolean {
  if (!runId) return false;
  const marker = readGoverningEngineMarker(metadata);
  if (!marker) return false;
  if (marker.workflowRunId !== runId) return true;
  return marker.runStatus !== undefined && marker.runStatus !== 'RUNNING';
}

// ── TASK-1059 — a note outcome reported while a hold stands waits for the release ────────────────

/**
 * The `Consultation.metadata` key under which a harness note outcome reported DURING a real guardrail
 * hold waits: the note writer keeps the hold and records what it would have written here; the release
 * (`GuardrailNoticeService.resumeHold`) applies it instead of a bare IDLE.
 */
export const GUARDRAIL_DEFERRED_OUTCOME_KEY = 'guardrailHoldDeferredOutcome';

/** A deferred note outcome. `holdSince` is the hold's `processingUpdatedAt`: it binds the outcome to THAT hold. */
export interface GuardrailDeferredOutcome {
  processing: ConsultationProcessing;
  reason: string | null;
  holdSince: string | null;
}

type HoldView = { processing?: unknown; processingReason?: string | null; processingUpdatedAt?: Date | string | null; metadata?: unknown };

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `processing` says the consultation is on a guardrail hold (AWAITING_REVIEW with a hold reason). */
export function isOnGuardrailHold(consultation: HoldView): boolean {
  return consultation.processing === ConsultationProcessing.AWAITING_REVIEW && isGuardrailHoldReason(consultation.processingReason);
}

/**
 * Whether the consultation still has a BLOCKED notice nobody resolved (OPEN or ACKNOWLEDGED — the same
 * set `resumeHold` counts as still holding). Filtered in the query AND here.
 */
export async function hasUnresolvedGuardrailBlock(
  notices: Pick<GuardrailNoticeRepository, 'findAll'>,
  tenantId: string,
  consultationId: string,
): Promise<boolean> {
  const unresolved: string[] = [GuardrailNoticeStatus.OPEN, GuardrailNoticeStatus.ACKNOWLEDGED];
  const rows = await notices.findAll({
    where: { tenantId, consultationId, type: GuardrailNoticeType.BLOCKED, status: { in: unresolved } } as never,
  });
  return rows.some(
    (row) =>
      row.tenantId === tenantId &&
      row.consultationId === consultationId &&
      String(row.type) === GuardrailNoticeType.BLOCKED &&
      unresolved.includes(String(row.status)),
  );
}

/** `metadata` with the deferred outcome recorded against the consultation's CURRENT hold. Every other key is kept. */
export function withGuardrailDeferredOutcome(
  consultation: HoldView,
  outcome: { processing: ConsultationProcessing; reason?: string | null },
): Record<string, JsonValue> {
  const base = consultation.metadata && typeof consultation.metadata === 'object' && !Array.isArray(consultation.metadata)
    ? (consultation.metadata as Record<string, JsonValue>)
    : {};
  const deferred: GuardrailDeferredOutcome = {
    processing: outcome.processing,
    reason: outcome.reason ?? null,
    holdSince: isoOrNull(consultation.processingUpdatedAt),
  };
  return { ...base, [GUARDRAIL_DEFERRED_OUTCOME_KEY]: deferred as unknown as JsonValue };
}

/**
 * The outcome deferred during the hold that is STILL in place, or `null`. An outcome recorded against an
 * earlier hold (its `holdSince` is not the current `processingUpdatedAt`) is stale and ignored.
 */
export function guardrailDeferredOutcomeOf(consultation: HoldView): GuardrailDeferredOutcome | null {
  const metadata = consultation.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[GUARDRAIL_DEFERRED_OUTCOME_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const outcome = raw as Partial<GuardrailDeferredOutcome>;
  if (!Object.values(ConsultationProcessing).includes(outcome.processing as ConsultationProcessing)) return null;
  if ((outcome.holdSince ?? null) !== isoOrNull(consultation.processingUpdatedAt)) return null;
  return { processing: outcome.processing as ConsultationProcessing, reason: outcome.reason ?? null, holdSince: outcome.holdSince ?? null };
}

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
          return this.holdInTransaction(tenantId, consultationId, notice.noticeId, guardrailHoldReasonOf(notice), tx, { runId: notice.runId });
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
   * (logged) for an unknown, foreign, approved or closed consultation, and — when `scope.runId` names
   * the run the block came from — for a run that is over (superseded or terminal, TASK-1059).
   */
  async holdInTransaction(
    tenantId: string,
    consultationId: string,
    noticeId: string,
    reason: string,
    tx?: unknown,
    scope: { runId?: string | null } = {},
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
    if (guardrailRunIsOver(consultation.metadata, scope.runId)) {
      this.logger.log({
        message: 'Guardrail hold not entered — the run the block came from is over (superseded or terminal)',
        consultationId,
        noticeId,
        runId: scope.runId,
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
