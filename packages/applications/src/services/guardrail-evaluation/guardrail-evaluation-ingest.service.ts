import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ContextItemRepository,
  CoreUnitOfWorkService,
  GuardrailEvaluationFactory,
  GuardrailEvaluationRepository,
  GuardrailItemStatus,
  GuardrailNoticeRepository,
  ResourceType,
  SysEventType,
  type GuardrailEvaluationEntity,
  type GuardrailNoticeEntity,
  type JsonValue,
} from '@arcaai/domains';
import {
  GUARDRAIL_EVALUATION_BATCH_MAX,
  type GuardrailEvaluationBatchRequest,
  type GuardrailEvaluationBatchResponse,
  type GuardrailEvaluationRecord,
} from '@arcaai/types';
import { BaseService } from '../../common';
import { encryptPhiFields } from '../../common/phi-field-encryption';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import {
  GuardrailHoldService,
  guardrailHoldReasonOf,
  guardrailNoticeRow,
  type GuardrailHoldApplied,
} from '../guardrail-notice/guardrail-hold.service';
import { decisionToRow, directionToRow, itemStatusRank, strongerItemStatus } from '../guardrail-notice/guardrail-wire';

/** Machine codes of the ingest's 400s (a client — guardrail's drainer — branches on them). */
export const GUARDRAIL_EVALUATION_ERROR_CODES = Object.freeze({
  batchSize: 'GUARDRAIL_EVALUATION_BATCH_SIZE',
  tenantMismatch: 'GUARDRAIL_EVALUATION_TENANT_MISMATCH',
} as const);

const PHI_TRANSIT_KEY = 'hope-phi';

interface MarkTarget {
  status: GuardrailItemStatus;
  version: number;
  consultationId: string | null;
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
 *  4. a block with a consultation ENTERS THE HOLD through `GuardrailHoldService` (the one hold-entry
 *     path): `processing` AWAITING_REVIEW with reason GUARDRAIL_HOLD (EGRESS_REDACTION_UNAVAILABLE
 *     for the egress privacy hold) — only for a NEW notice: an id already stored (entered by the run
 *     watcher, or resolved by the clinician) holds nothing again.
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
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Unwired ⇒ the writes run in sequence (unit fixtures).
    @Optional() @Inject(CoreUnitOfWorkService) private readonly unitOfWork?: Pick<CoreUnitOfWorkService, 'runInTransaction'>,
    // The ONE hold-entry path (shared with TEXT's redaction hold and the run watcher). Unwired ⇒ a
    // block is recorded, and no consultation is held.
    @Optional() @Inject(GuardrailHoldService) private readonly holds?: Pick<GuardrailHoldService, 'holdInTransaction' | 'announce'>,
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
    const holds: GuardrailHoldApplied[] = [];
    const write = async (tx?: unknown) => {
      const storedNoticeIds = new Map<string, string>();
      const intents: Array<{ consultationId: string; noticeId: string; reason: string }> = [];
      for (const record of fresh) {
        for (const notice of record.notices ?? []) {
          if (!record.noticeIds.includes(notice.noticeId) || storedNoticeIds.has(notice.noticeId)) continue;
          const { notice: row, created } = await this.notices.upsertByDedupeKey(guardrailNoticeRow(tenantId, notice), tx);
          storedNoticeIds.set(notice.noticeId, row.id);
          if (!created) continue;
          createdNotices.push(row);
          // A hold is entered for a NEW notice only: the same id seen before (the run watcher, an
          // earlier batch) is already holding — or was resolved by the clinician.
          const consultationId = record.consultationId ?? notice.consultationId;
          if (record.decision === 'block' && notice.type === 'guardrail.blocked' && consultationId) {
            intents.push({ consultationId, noticeId: row.id, reason: guardrailHoldReasonOf(notice) });
          }
        }
      }

      const entities = fresh.map((record) => this.evaluationEntity(record, storedNoticeIds, sealed.get(record.evaluationId)));
      const result = await this.evaluations.createManyIdempotent(entities, tx);
      await this.applyMarkers(tenantId, targets, items as never, tx);
      const seen = new Set<string>();
      for (const intent of intents) {
        if (!this.holds || seen.has(intent.consultationId)) continue;
        seen.add(intent.consultationId);
        const applied = await this.holds.holdInTransaction(tenantId, intent.consultationId, intent.noticeId, intent.reason, tx);
        if (applied) holds.push(applied);
      }
      return result;
    };
    const result = this.unitOfWork ? await this.unitOfWork.runInTransaction((tx) => write(tx)) : await write();

    for (const hold of holds) await this.holds?.announce(hold);
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
      ...(record.itemId ? { metaData: { itemId: record.itemId } } : {}),
    });
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
          const ciphertext = await this.secrets!.encrypt(
            Buffer.from(record.withheldContent!, 'utf8'),
            this.secrets!.getPhiTransitKeyName?.() ?? PHI_TRANSIT_KEY,
          );
          sealed.set(record.evaluationId, { ciphertext: Buffer.from(ciphertext, 'utf8'), keyVersion: keyVersionOf(ciphertext) });
        },
        this.logger,
      );
    }
    return sealed;
  }

  // ── item marking ──────────────────────────────────────────────────────────────────────────

  /**
   * The strongest marker each FLAGGED item earned (warn → WARNED, block → BLOCKED). A check's `items`
   * are every item its regions COVERED; when the record carries a notice for the check, only the items
   * that notice names were flagged (an instruction-region flag names none). A check no notice names —
   * a TEXT- or harness-minted record — keeps marking what it covered.
   */
  private markTargets(records: readonly GuardrailEvaluationRecord[]): Map<string, MarkTarget> {
    const targets = new Map<string, MarkTarget>();
    for (const record of records) {
      const flaggedByCheck = new Map<string, Set<string>>();
      for (const notice of record.notices ?? []) {
        for (const noticeCheck of notice.checks) {
          const flagged = flaggedByCheck.get(noticeCheck.checkId) ?? new Set<string>();
          for (const itemId of notice.itemIds) flagged.add(itemId);
          flaggedByCheck.set(noticeCheck.checkId, flagged);
        }
      }
      for (const check of record.checks) {
        const status = check.actionTaken === 'block' ? GuardrailItemStatus.BLOCKED : check.actionTaken === 'warn' ? GuardrailItemStatus.WARNED : null;
        if (!status) continue;
        const flagged = flaggedByCheck.get(check.checkId);
        for (const ref of (check.items ?? []).filter((one) => !flagged || flagged.has(one.itemId))) {
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
}
