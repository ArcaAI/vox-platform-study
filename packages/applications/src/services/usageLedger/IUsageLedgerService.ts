import type { CorePrisma } from '@arcaai/domains';

import type { RecordUsageResult, UsageEventBatchInput, UsageEventInput } from './dto';

/**
 * The usage-emission port (TASK-615 WS-B — FROZEN once this branch merges).
 *
 * ============================================================================
 * WHAT `recordUsage` DOES — AND POINTEDLY DOES NOT DO
 * ============================================================================
 * It writes an `AiUsageOutbox` row. It does NOT write the ledger, does NOT
 * resolve a price, and does NOT call a provider. Rating and the ledger append
 * happen later, in the drainer, off the caller's critical path.
 *
 * That split is the whole design (D3):
 *
 *   - **Pass `tx`** and the outbox row commits with the business row that
 *     produced the usage. Usage can then never be lost by a crash between "work
 *     done" and "usage recorded", and can never be recorded for work that
 *     rolled back. Both halves matter: the first is a revenue leak, the second
 *     is a charge for something that never happened.
 *   - **Omit `tx`** only when there is no business transaction to join — a
 *     stream teardown, say, where the work already committed elsewhere.
 *
 * IT DERIVES NOTHING SILENTLY. A missing or malformed field raises
 * `ArgumentInvalidException` listing EVERY violation. In particular it never
 * infers `costBasis` from `deployment` and never defaults `occurredAt` to now.
 *
 * IT IS SAFE TO CALL TWICE. Idempotency keys are intent-derived, so a retried
 * emission converges on one ledger row at the drainer. This is what lets the
 * abort path emit unconditionally using the same key the completion path would.
 */
export interface IUsageLedgerService {
  /**
   * Record usage as outbox work.
   *
   * @param input One event, an array of events, or the `{common, units}` batch
   *              shape (which expands per-unit keys and drops zero quantities).
   * @param tx    The caller's Prisma transaction client. Supply it whenever the
   *              usage is produced by a transactional business write.
   *
   * @throws ArgumentInvalidException when any event is invalid — NOTHING is
   *         written in that case, so a corrected retry is a clean first attempt.
   */
  recordUsage(input: UsageEventInput | UsageEventInput[] | UsageEventBatchInput, tx?: CorePrisma.TransactionClient): Promise<RecordUsageResult>;
}

export const IUsageLedgerService = Symbol('IUsageLedgerService');
