import { Injectable, Logger } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { AiCostBasis, AiDeploymentKind, AiUsageOutboxFactory, AiUsageOutboxRepository, CorePrisma } from '@arcaai/domains';

import { IUsageLedgerService } from './IUsageLedgerService';
import { RecordUsageResult, USAGE_OUTBOX_PAYLOAD_VERSION, UsageEventBatchInput, UsageEventInput, UsageOutboxPayload } from './dto';
import { expandUsageBatch, serializeUsageEvent, validateUsageEventInput } from './usage-event.validation';

/**
 * The usage-emission write path (TASK-615 WS-B deliverable 1).
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
    this.warnOnUnflaggedByok(events);

    const outboxIds: string[] = [];
    for (const [tenantId, tenantEvents] of groupByTenant(events)) {
      const payload: UsageOutboxPayload = {
        version: USAGE_OUTBOX_PAYLOAD_VERSION,
        events: tenantEvents.map(serializeUsageEvent),
      };

      const entity = AiUsageOutboxFactory.CreateAiUsageOutbox({
        tenantId,
        // The factory's own JSON typing is structural; the payload is a plain
        // serialisable object by construction (see `usage-outbox.payload.ts`).
        payload: payload as unknown as Record<string, unknown>,
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
   * A BYOK call left on the INTERNAL cost basis is almost certainly a forgotten
   * flag — but it is NOT corrected here.
   *
   * Deriving `BYOK_NOTIONAL` from `deployment` would make the omission
   * invisible, and the two fields are not synonyms: BYOK→platform failover is a
   * genuinely INTERNAL call made on a BYOK tenant's behalf (D14). The default's
   * direction of error — over-reporting platform spend — is the safe one, so a
   * warning is the whole intervention.
   */
  private warnOnUnflaggedByok(events: UsageEventInput[]): void {
    const suspects = events.filter((event) => event.deployment === AiDeploymentKind.BYOK && (event.costBasis ?? AiCostBasis.INTERNAL) !== AiCostBasis.BYOK_NOTIONAL);

    if (suspects.length > 0) {
      this.logger.warn({
        message: 'BYOK usage recorded on the INTERNAL cost basis — platform spend will be over-reported unless this was a BYOK-to-platform failover',
        count: suspects.length,
        tenantId: suspects[0].tenantId,
        capability: suspects[0].capability,
        provider: suspects[0].provider,
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
