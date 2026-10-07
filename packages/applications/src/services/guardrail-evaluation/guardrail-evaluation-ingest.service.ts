import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationProcessing,
  ConsultationRepository,
  ConsultationStatus,
  ContextItemRepository,
  CoreUnitOfWorkService,
  GuardrailEvaluationFactory,
  GuardrailEvaluationRepository,
  GuardrailItemStatus,
  GuardrailNoticeEntityMapper,
  GuardrailNoticeFactory,
  GuardrailNoticeRepository,
  ResourceType,
  SysEventType,
  type GuardrailEvaluationEntity,
  type GuardrailNoticeEntity,
  type JsonValue,
} from '@arcaai/domains';
import {
  EGRESS_REDACTION_UNAVAILABLE_REASON,
  GUARDRAIL_EVALUATION_BATCH_MAX,
  GUARDRAIL_HOLD_REASON,
  type GuardrailEvaluationBatchRequest,
  type GuardrailEvaluationBatchResponse,
  type GuardrailEvaluationRecord,
  type GuardrailNotice,
} from '@arcaai/types';
import { BaseService } from '../../common';
import { encryptPhiFields } from '../../common/phi-field-encryption';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IConsultationLifecycleService, IConsultationLifecycleServiceToken } from '../consultation/lifecycle/IConsultationLifecycleService';
import { ConsultationLifecycleEventPublisher } from '../consultation/lifecycle/lifecycle-event.publisher';
import {
  decisionToRow,
  directionToRow,
  itemStatusRank,
  noticeSeverity,
  noticeTypeToRow,
  strongerItemStatus,
} from '../guardrail-notice/guardrail-wire';

/** Machine codes of the ingest's 400s (a client — guardrail's drainer — branches on them). */
export const GUARDRAIL_EVALUATION_ERROR_CODES = Object.freeze({
  batchSize: 'GUARDRAIL_EVALUATION_BATCH_SIZE',
  tenantMismatch: 'GUARDRAIL_EVALUATION_TENANT_MISMATCH',
} as const);

/** A consultation in one of these states is past its visit: a block is recorded, never held. */
const NOT_HOLDABLE: ReadonlySet<string> = new Set([
  ConsultationStatus.APPROVED,
  ConsultationStatus.CLOSED_COMPLETE,
  ConsultationStatus.CLOSED_INCOMPLETE,
]);

const PHI_TRANSIT_KEY = 'hope-phi';

interface MarkTarget {
  status: GuardrailItemStatus;
  version: number;
  consultationId: string | null;
}

interface HoldIntent {
  consultationId: string;
  noticeId: string;
  reason: string;
}

interface HoldApplied extends HoldIntent {
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

/** Vault Transit ciphertext is `vault:vN:<b64>`; a malformed shape reads as the bootstrap version 1. */
function keyVersionOf(ciphertext: string): number {
  const match = /^vault:v(\d+):/.exec(ciphertext);
  const version = match ? Number.parseInt(match[1], 10) : 1;
  return Number.isFinite(version) && version > 0 ? version : 1;
}

function isOutboundBlock(record: GuardrailEvaluationRecord): boolean {
  return record.direction === 'outbound' && record.decision === 'block';
}

/**
 * TASK-1050 W2e — the gateway half of guardrail's at-least-once evaluation outbox
 * (`POST internal/guardrail/evaluations`, README §9.8.2). The gateway is the ONLY writer of
 * guardrail outcomes (§9.7.1): guardrail decides, this records and enforces.
 *
 * One transaction per batch, in this order:
 *  1. the batch's notices, keyed on guardrail's DETERMINISTIC `noticeId` (a UUID of
 *     sha256(tenantId|dedupeKey), so a re-raise arrives with the same id and is a no-op on the
 *     stored row; notices with different ids are never collapsed, so every id a client holds
 *     resolves). TEXT- and harness-minted notices carry their own ids and are stored the same way;
 *  2. the evaluations (`createManyIdempotent`, idempotent on `evaluationId`), their `noticeIds`
 *     pointing at the STORED notices;
 *  3. the item markers — WARNED / BLOCKED on an item whose CURRENT version is the screened one,
 *     never downgraded, never bumping `_version` (OD-21);
 *  4. a block with a consultation ENTERS THE HOLD: `processing` AWAITING_REVIEW with reason
 *     GUARDRAIL_HOLD (EGRESS_REDACTION_UNAVAILABLE for the egress privacy hold).
 * After the commit: capture is paused (a RECORDING consultation → PAUSED), a state-only lifecycle
 * event carries the notice id as a pointer, and the sys-events are broadcast.
 *
 * Redrive is safe: an evaluation already stored is a duplicate and drives nothing at all.
 * Withheld text (outbound block only) is sealed with Vault Transit before the transaction and is
 * stored only as ciphertext.
 */
@Injectable()
export class GuardrailEvaluationIngestService extends BaseService {
  private readonly logger = new Logger(GuardrailEvaluationIngestService.name);

  constructor(
    private readonly evaluations: GuardrailEvaluationRepository,
    private readonly notices: GuardrailNoticeRepository,
    private readonly contextItems: ContextItemRepository,
    private readonly consultations: ConsultationRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Unwired ⇒ the writes run in sequence (unit fixtures).
    @Optional() @Inject(CoreUnitOfWorkService) private readonly unitOfWork?: Pick<CoreUnitOfWorkService, 'runInTransaction'>,
    @Optional() private readonly lifecycleEvents?: Pick<ConsultationLifecycleEventPublisher, 'publish'>,
    // `pause` stops capture on a held RECORDING consultation. Unwired ⇒ processing still holds it.
    @Optional() @Inject(IConsultationLifecycleServiceToken) private readonly lifecycle?: Pick<IConsultationLifecycleService, 'pause'>,
    @Optional() @Inject(SecretsService) private readonly secrets?: Pick<SecretsService, 'encrypt'> & { getPhiTransitKeyName?(): string | undefined },
  ) {
    super(eventEmitter, clsService, ResourceType.GuardrailEvaluation);
  }

  async ingest(tenantId: string, batch: GuardrailEvaluationBatchRequest): Promise<GuardrailEvaluationBatchResponse> {
    const records = Array.isArray(batch?.evaluations) ? batch.evaluations : [];
    if (records.length === 0 || records.length > GUARDRAIL_EVALUATION_BATCH_MAX) {
      throw new BadRequestException({
        code: GUARDRAIL_EVALUATION_ERROR_CODES.batchSize,
        message: `A batch carries 1..${GUARDRAIL_EVALUATION_BATCH_MAX} evaluations (got ${records.length}).`,
      });
    }
    if (records.some((record) => record.tenantId !== tenantId)) {
      throw new BadRequestException({
        code: GUARDRAIL_EVALUATION_ERROR_CODES.tenantMismatch,
        message: 'Every evaluation must belong to the X-Tenant-Id tenant.',
      });
    }

    const unique = new Map<string, GuardrailEvaluationRecord>();
    for (const record of records) if (!unique.has(record.evaluationId)) unique.set(record.evaluationId, record);
    const stored = new Set(
      (await this.evaluations.findAll({ where: { tenantId, id: { in: [...unique.keys()] } } as never })).map((row: { id: string }) => row.id),
    );
    const fresh = [...unique.values()].filter((record) => !stored.has(record.evaluationId));
    const duplicates = records.length - fresh.length;
    if (fresh.length === 0) return { accepted: 0, duplicates };

    // Vault and the item read stay outside the transaction: neither needs its isolation.
    const sealed = await this.sealWithheld(fresh);
    const targets = this.markTargets(fresh);
    const items = targets.size > 0 ? await this.contextItems.findAll({ where: { id: { in: [...targets.keys()] } } as never }) : [];

    const createdNotices: GuardrailNoticeEntity[] = [];
    const holds: HoldApplied[] = [];
    const write = async (tx?: unknown) => {
      const storedNoticeIds = new Map<string, string>();
      const intents: HoldIntent[] = [];
      for (const record of fresh) {
        for (const notice of record.notices ?? []) {
          if (!record.noticeIds.includes(notice.noticeId) || storedNoticeIds.has(notice.noticeId)) continue;
          const { notice: row, created } = await this.notices.upsertByDedupeKey(this.noticeEntity(tenantId, notice), tx);
          storedNoticeIds.set(notice.noticeId, row.id);
          if (created) createdNotices.push(row);
          const consultationId = record.consultationId ?? notice.consultationId;
          if (record.decision === 'block' && notice.type === 'guardrail.blocked' && consultationId && String(row.status) !== 'RESOLVED') {
            intents.push({ consultationId, noticeId: row.id, reason: this.holdReason(notice) });
          }
        }
      }

      const entities = fresh.map((record) => this.evaluationEntity(record, storedNoticeIds, sealed.get(record.evaluationId)));
      const result = await this.evaluations.createManyIdempotent(entities, tx);
      await this.applyMarkers(tenantId, targets, items as never, tx);
      holds.push(...(await this.enterHolds(tenantId, intents, tx)));
      return result;
    };
    const result = this.unitOfWork ? await this.unitOfWork.runInTransaction((tx) => write(tx)) : await write();

    await this.afterCommit(holds);
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceType: ResourceType.GuardrailEvaluation,
      data: { action: 'guardrail_evaluations_ingested', count: result.inserted, evaluationIds: fresh.map((record) => record.evaluationId) },
    });
    for (const notice of createdNotices) {
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: notice.id,
        resourceType: ResourceType.GuardrailNotice,
        data: { action: 'guardrail_notice_raised', consultationId: notice.consultationId ?? null, type: notice.type, messageKey: notice.messageKey },
      });
    }

    return { accepted: result.inserted, duplicates: duplicates + result.duplicates };
  }

  // ── notices and evaluations ───────────────────────────────────────────────────────────────

  /** The stored notice under guardrail's id: the run stream and the record name it by that id. */
  private noticeEntity(tenantId: string, notice: GuardrailNotice): GuardrailNoticeEntity {
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
      // The id IS the dedupe key: guardrail derives it from (tenant, consultation-or-request, check,
      // item-or-region, policyVersion), so keying the upsert on it dedupes exactly as guardrail did.
      dedupeKey: notice.noticeId,
      createdAt: new Date(notice.occurredAt),
    });
    // TODO(TASK-1050 W0 follow-up): `GuardrailNoticeFactory` mints its own id; the notice id is
    // guardrail's (minted before it answered), so the row is re-read through the mapper with it.
    const mapper = GuardrailNoticeEntityMapper.getInstance();
    return mapper.toDomainEntity({ ...(mapper.toPersistence(draft) as object), id: notice.noticeId } as never);
  }

  private evaluationEntity(
    record: GuardrailEvaluationRecord,
    storedNoticeIds: ReadonlyMap<string, string>,
    sealed: { ciphertext: Buffer; keyVersion: number } | undefined,
  ): GuardrailEvaluationEntity {
    return GuardrailEvaluationFactory.CreateGuardrailEvaluation({
      id: record.evaluationId,
      tenantId: record.tenantId,
      requestId: record.requestId,
      consultationId: record.consultationId ?? null,
      runId: record.runId ?? null,
      runKey: record.runKey ?? null,
      nodeId: record.nodeId ?? null,
      agentSlug: record.agentSlug ?? null,
      caller: record.caller,
      direction: directionToRow(record.direction),
      decision: decisionToRow(record.decision),
      exempt: record.exempt ?? null,
      checks: record.checks.map((check) => ({ ...check })) as unknown as JsonValue,
      policyVersion: record.policyVersion,
      noticeIds: [...new Set(record.noticeIds.map((id) => storedNoticeIds.get(id) ?? id))],
      encryptedWithheldContent: sealed?.ciphertext ?? null,
      keyVersion: sealed?.keyVersion ?? null,
      at: new Date(record.occurredAt),
      ...(record.itemId ? { metaData: { itemId: record.itemId } as unknown as JsonValue } : {}),
    });
  }

  private holdReason(notice: GuardrailNotice): string {
    return notice.messageKey === 'guardrail.blocked.redaction_unavailable' ? EGRESS_REDACTION_UNAVAILABLE_REASON : GUARDRAIL_HOLD_REASON;
  }

  /** Outbound-block withheld text only, sealed under the PHI Transit key. Fail-closed in vault mode. */
  private async sealWithheld(records: readonly GuardrailEvaluationRecord[]): Promise<Map<string, { ciphertext: Buffer; keyVersion: number }>> {
    const sealed = new Map<string, { ciphertext: Buffer; keyVersion: number }>();
    for (const record of records) {
      if (!record.withheldContent) continue;
      if (!isOutboundBlock(record)) {
        this.logger.warn({ message: 'Withheld content on a record that is not an outbound block was dropped', evaluationId: record.evaluationId });
        continue;
      }
      await encryptPhiFields(
        this.secrets,
        'GuardrailEvaluation withheld content',
        async () => {
          const ciphertext = await this.secrets!.encrypt(Buffer.from(record.withheldContent!, 'utf8'), this.secrets!.getPhiTransitKeyName?.() ?? PHI_TRANSIT_KEY);
          sealed.set(record.evaluationId, { ciphertext: Buffer.from(ciphertext, 'utf8'), keyVersion: keyVersionOf(ciphertext) });
        },
        this.logger,
      );
    }
    return sealed;
  }

  // ── item marking ──────────────────────────────────────────────────────────────────────────

  /** The strongest marker each screened item earned (warn → WARNED, block → BLOCKED). */
  private markTargets(records: readonly GuardrailEvaluationRecord[]): Map<string, MarkTarget> {
    const targets = new Map<string, MarkTarget>();
    for (const record of records) {
      for (const check of record.checks) {
        const status =
          check.actionTaken === 'block' ? GuardrailItemStatus.BLOCKED : check.actionTaken === 'warn' ? GuardrailItemStatus.WARNED : null;
        if (!status) continue;
        for (const ref of check.items ?? []) {
          const prior = targets.get(ref.itemId);
          if (prior && prior.version !== ref.itemVersion) {
            // Two versions of one item in one batch: the newer screen speaks for the item.
            if (ref.itemVersion < prior.version) continue;
            targets.set(ref.itemId, { status, version: ref.itemVersion, consultationId: record.consultationId ?? null });
            continue;
          }
          targets.set(ref.itemId, {
            status: strongerItemStatus(prior?.status, status),
            version: ref.itemVersion,
            consultationId: record.consultationId ?? prior?.consultationId ?? null,
          });
        }
      }
    }
    return targets;
  }

  /**
   * Mark only the CURRENT version that was screened (an edited item is a new version, unmarked and
   * re-screened), only inside the record's tenant and consultation, and never downgrade.
   */
  private async applyMarkers(
    tenantId: string,
    targets: ReadonlyMap<string, MarkTarget>,
    items: ReadonlyArray<{ id: string; tenantId: string; consultationId?: string | null; currentVersionNumber?: number; guardrailStatus?: string }>,
    tx: unknown,
  ): Promise<void> {
    const byStatus = new Map<GuardrailItemStatus, string[]>();
    for (const item of items) {
      const target = targets.get(item.id);
      if (!target || item.tenantId !== tenantId) continue;
      if (target.consultationId && item.consultationId !== target.consultationId) continue;
      if (Number(item.currentVersionNumber ?? 1) !== target.version) continue;
      if (itemStatusRank(item.guardrailStatus) >= itemStatusRank(target.status)) continue;
      byStatus.set(target.status, [...(byStatus.get(target.status) ?? []), item.id]);
    }
    for (const [status, ids] of byStatus) await this.contextItems.setGuardrailStatusMany(ids, status, tx);
  }

  // ── the hold ──────────────────────────────────────────────────────────────────────────────

  private async enterHolds(tenantId: string, intents: readonly HoldIntent[], tx: unknown): Promise<HoldApplied[]> {
    const applied: HoldApplied[] = [];
    const seen = new Set<string>();
    for (const intent of intents) {
      if (seen.has(intent.consultationId)) continue;
      seen.add(intent.consultationId);
      const consultation = await this.consultations.findByIdOrNull(intent.consultationId);
      if (!consultation || consultation.tenantId !== tenantId || NOT_HOLDABLE.has(String(consultation.status))) continue;
      await this.consultations.setProcessing(intent.consultationId, ConsultationProcessing.AWAITING_REVIEW, { reason: intent.reason }, tx);
      applied.push({
        ...intent,
        pause: String(consultation.status) === ConsultationStatus.RECORDING,
        subject: {
          id: consultation.id,
          tenantId: consultation.tenantId,
          status: String(consultation.status),
          processing: ConsultationProcessing.AWAITING_REVIEW,
          processingReason: intent.reason,
          closedReason: consultation.closedReason ?? null,
          currentEncounterSeq: consultation.currentEncounterSeq,
          version: consultation.version,
        },
      });
    }
    return applied;
  }

  /** Capture stops and clients learn of the hold — best-effort, the hold is already committed. */
  private async afterCommit(holds: readonly HoldApplied[]): Promise<void> {
    for (const hold of holds) {
      let status = hold.subject.status;
      let version = hold.subject.version;
      if (hold.pause && this.lifecycle) {
        try {
          const state = (await this.lifecycle.pause(hold.consultationId, { reason: 'guardrail_hold' })) as { status?: string; version?: number } | undefined;
          status = state?.status ?? ConsultationStatus.PAUSED;
          version = state?.version ?? version;
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
    }
  }
}
