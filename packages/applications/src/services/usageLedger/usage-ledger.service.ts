import { Injectable, Logger } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { AiCostBasis, AiDeploymentKind, AiUsageOutboxFactory, AiUsageOutboxRepository, CorePrisma, JsonObject } from '@arcaai/domains';

import { IUsageLedgerService } from './IUsageLedgerService';
import { RecordUsageResult, USAGE_OUTBOX_PAYLOAD_VERSION, UsageEventBatchInput, UsageEventInput, UsageOutboxPayload } from './dto';
import { expandUsageBatch, serializeUsageEvent, validateUsageEventInput } from './usage-event.validation';

/**
 * The usage-emission write path (deliverable 1).
 *
 * See {@link IUsageLedgerService} for the contract. Two implementation notes
 * that are load-bearing and not obvious from the interface:
 *
 * **It does not extend `BaseService`.** `BaseService` exists to broadcast
 * sys-events and to change-track entity updates; this plane does NEITHER by
 * design (per-call metering at request volume would flood the audit trail with
 * rows carrying no compliance meaning — see `usage-ledger.prisma`), and the
 * outbox row is created, never updated. Extending it would import a base class
 * for none of its behaviour.
 *
 * **One outbox row per tenant per call, not per event.** A logical AI call
 * emits several unit rows; packing them into one payload keeps the drain of one
 * call atomic and keeps the outbox small. An array spanning tenants still
 * splits: `AiUsageOutbox.tenantId` is a single column, and mis-stamping it
 * would attribute one tenant's spend to another.
 */
@Injectable()
export class UsageLedgerService implements IUsageLedgerService {
  private readonly logger = new Logger(UsageLedgerService.name);

  constructor(private readonly outboxRepository: AiUsageOutboxRepository) {}

  async recordUsage(
    input: UsageEventInput | UsageEventInput[] | UsageEventBatchInput,
    tx?: CorePrisma.TransactionClient,
  ): Promise<RecordUsageResult> {
    const events = normalizeToInputs(input);
    if (events.length === 0) {
      // A batch whose units were all zero, or an explicitly empty array. Both
      // are legitimate "nothing was consumed" outcomes, not errors.
      return { outboxIds: [], events: 0 };
    }

    this.assertValid(events);
    this.warnOnInconsistentCostBasis(events);

    const outboxIds: string[] = [];
    for (const [tenantId, tenantEvents] of groupByTenant(events)) {
      const payload: UsageOutboxPayload = {
        version: USAGE_OUTBOX_PAYLOAD_VERSION,
        events: tenantEvents.map(serializeUsageEvent),
      };

      const entity = AiUsageOutboxFactory.CreateAiUsageOutbox({
        tenantId,
        // `JsonObject` demands a string index signature, which a named
        // interface deliberately does not carry. The payload IS plain
        // serialisable data by construction (see `usage-outbox.payload.ts`), so
        // the cast asserts what the shape already guarantees rather than
        // widening the DTO into an untyped bag.
        payload: payload as unknown as JsonObject,
      });

      // `tx` threads the write into the CALLER's transaction — the outbox
      // guarantee. Without it the row commits on its own, which is correct only
      // when there is no business transaction to join.
      await this.outboxRepository.create(entity, tx);
      outboxIds.push(entity.id);
    }

    return { outboxIds, events: events.length };
  }

  /**
   * Validate every event before writing ANYTHING.
   *
   * All-or-nothing on purpose: a partial write would leave the emitter's retry
   * (with the same intent-derived keys) racing its own earlier rows, and the
   * caller has no way to know which half landed.
   */
  private assertValid(events: UsageEventInput[]): void {
    const violations: string[] = [];

    events.forEach((event, index) => {
      for (const violation of validateUsageEventInput(event)) {
        // Index the message so an array caller knows WHICH row to fix.
        violations.push(events.length > 1 ? `[${index}] ${violation}` : violation);
      }
    });

    if (violations.length > 0) {
      throw new ArgumentInvalidException(`Invalid usage event(s): ${violations.join('; ')}`);
    }
  }

  /**
   * `deployment` and `costBasis` disagreeing is almost certainly a forgotten
   * flag — but it is NOT corrected here.
   *
   * Deriving one from the other would make the omission invisible, and they are
   * not synonyms: BYOK→platform failover is a genuinely INTERNAL call made on a
   * BYOK tenant's behalf (D14). So a warning is the whole intervention, in both
   * directions:
   *
   *  - **BYOK + INTERNAL** — platform spend over-reported. The safe direction
   *    to be wrong in, which is exactly why it needs saying out loud.
   *  - **non-BYOK + BYOK_NOTIONAL** — platform spend SILENTLY LOST. The drainer
   *    contributes `0` to every COGS rollup for a `BYOK_NOTIONAL` row
   *    (`usage-outbox.drainer.ts`), and billing resolves the provider-agnostic
   *    baseline SELL price rather than the managed-vendor row. Added by
   * Since a platform-funded call meters as the EXISTING `CLOUD`
   *    member (OD-2), a mis-attributed one carries no novel enum value and no
   *    "did something unknown appear" check can ever catch it. Shadow metering
   *    filters to `CLOUD`, so the mis-stamped events drop out of the one
   *    reconciliation that would otherwise notice. This warning is the guard.
   */
  private warnOnInconsistentCostBasis(events: UsageEventInput[]): void {
    const effectiveBasis = (event: UsageEventInput): AiCostBasis => event.costBasis ?? AiCostBasis.INTERNAL;

    const unflaggedByok = events.filter((event) => event.deployment === AiDeploymentKind.BYOK && effectiveBasis(event) !== AiCostBasis.BYOK_NOTIONAL);
    if (unflaggedByok.length > 0) {
      this.logger.warn({
        message: 'BYOK usage recorded on the INTERNAL cost basis — platform spend will be over-reported unless this was a BYOK-to-platform failover',
        count: unflaggedByok.length,
        tenantId: unflaggedByok[0].tenantId,
        capability: unflaggedByok[0].capability,
        provider: unflaggedByok[0].provider,
      });
    }

    const notionalWithoutByok = events.filter(
      (event) => event.deployment !== AiDeploymentKind.BYOK && effectiveBasis(event) === AiCostBasis.BYOK_NOTIONAL,
    );
    if (notionalWithoutByok.length > 0) {
      this.logger.warn({
        message:
          'Non-BYOK usage recorded on the BYOK_NOTIONAL cost basis — this cost contributes NOTHING to the COGS rollups; a platform-funded call was probably mis-attributed',
        count: notionalWithoutByok.length,
        tenantId: notionalWithoutByok[0].tenantId,
        capability: notionalWithoutByok[0].capability,
        provider: notionalWithoutByok[0].provider,
        deployment: notionalWithoutByok[0].deployment,
      });
    }
  }
}

/** Collapse the three accepted call shapes onto one list. */
function normalizeToInputs(input: UsageEventInput | UsageEventInput[] | UsageEventBatchInput): UsageEventInput[] {
  if (Array.isArray(input)) return input;
  if (isBatchInput(input)) return expandUsageBatch(input);
  return [input];
}

function isBatchInput(input: UsageEventInput | UsageEventBatchInput): input is UsageEventBatchInput {
  return typeof input === 'object' && input !== null && 'units' in input && 'common' in input;
}

/** Preserves first-seen tenant order so a single-tenant call stays a single row. */
function groupByTenant(events: UsageEventInput[]): Map<string, UsageEventInput[]> {
  const grouped = new Map<string, UsageEventInput[]>();
  for (const event of events) {
    const bucket = grouped.get(event.tenantId);
    if (bucket) bucket.push(event);
    else grouped.set(event.tenantId, [event]);
  }
  return grouped;
}
