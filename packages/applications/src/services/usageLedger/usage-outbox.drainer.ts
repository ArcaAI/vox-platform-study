import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  AiUsageEventFactory,
  AiUsageEventRepository,
  AiUsageOutboxEntity,
  AiUsageOutboxRepository,
  AiUsageOutboxStatus,
  AiUsageRollupDailyRepository,
  AiUsageRollupHourlyRepository,
  AiCostBasis,
  CorePrisma,
  CoreUnitOfWorkService,
  generateId,
  JsonObject,
} from '@arcaai/domains';

import { IPriceBookService } from '../priceBook/IPriceBookService';
import { SerializedUsageEvent, USAGE_OUTBOX_PAYLOAD_VERSION, UsageOutboxPayload } from './dto';
import { computeCostMicros } from '../priceBook/price-book.resolution';
import {
  DEFAULT_DRAIN_BATCH_SIZE,
  MAX_DRAIN_ATTEMPTS,
  MAX_LAST_ERROR_LENGTH,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
} from './usage-ledger.constants';

/** What one sweep did. */
export interface DrainReport {
  /** Outbox rows claimed. */
  rows: number;
  /** Ledger events actually appended. */
  inserted: number;
  /** Events that were already recorded (idempotent redelivery). */
  skipped: number;
  /** Rows left for retry or parked as FAILED. */
  failed: number;
}

/**
 * The outbox drainer (TASK-615 WS-B deliverable 2).
 *
 * Converts PENDING `AiUsageOutbox` rows into rated `AiUsageEvent` appends plus
 * hourly/daily rollup increments.
 *
 * ============================================================================
 * WHY THE APPEND AND THE ROLLUP SHARE ONE TRANSACTION
 * ============================================================================
 * Delivery is at-least-once; the ledger's unique `idempotencyKey` is what makes
 * it exactly-once-EFFECTIVE. That works only if rollup maintenance is derived
 * from the INSERT OUTCOME rather than from "we processed this row":
 *
 *   - increment on every pass  -> a redelivery double-counts the aggregate;
 *   - increment only on insert, in a SEPARATE transaction -> a crash between
 *     them loses the increment forever, because the redrain sees the conflict
 *     and correctly skips.
 *
 * So the insert and both upserts run inside ONE `runInTransaction`. Either all
 * three commit or none do, and a redrain of a rolled-back attempt inserts
 * cleanly. The rollup upserts use in-database `increment` (WS-A's
 * `accumulate`), so concurrent drainers on different replicas accumulate rather
 * than clobber.
 *
 * ============================================================================
 * WHY THE CONFLICT IS CAUGHT OUTSIDE THE TRANSACTION
 * ============================================================================
 * Postgres aborts a transaction on ANY error, so a `P2002` raised inside it
 * poisons every later statement — including the "does the row already exist?"
 * re-read that `AiUsageEventRepository.createIfAbsent` would perform. The
 * drainer therefore calls plain `create(entity, tx)` and lets the conflict
 * propagate OUT of the transaction, where it is recognised and counted as a
 * skip. `createIfAbsent` remains the right call for a NON-transactional
 * emitter.
 *
 * CONTEXT: this runs with no CLS tenant, like the metering reconcile job. Every
 * row carries its own `tenantId`, which is stamped onto the event it becomes.
 *
 * The transaction helper is the DOMAINS `CoreUnitOfWorkService` — the one
 * `CoreDatabaseModule` actually provides and exports. (An identically named
 * class exists under `services/baseServices/unitsOfWork/`; it is wired into no
 * module and has no production caller.)
 */
@Injectable()
export class UsageOutboxDrainer {
  private readonly logger = new Logger(UsageOutboxDrainer.name);

  constructor(
    private readonly outboxRepository: AiUsageOutboxRepository,
    private readonly eventRepository: AiUsageEventRepository,
    private readonly hourlyRepository: AiUsageRollupHourlyRepository,
    private readonly dailyRepository: AiUsageRollupDailyRepository,
    @Inject(IPriceBookService) private readonly priceBook: IPriceBookService,
    private readonly unitOfWork: CoreUnitOfWorkService,
  ) {}

  /**
   * Claim and drain one batch of due outbox rows.
   *
   * A row that throws is recorded against ITSELF (attempts/backoff, or FAILED)
   * and the sweep continues — one poisoned payload must never stall the queue
   * behind it.
   */
  async drainBatch(limit: number = DEFAULT_DRAIN_BATCH_SIZE, now: Date = new Date()): Promise<DrainReport> {
    const rows = await this.outboxRepository.findClaimable(limit, now);
    const report: DrainReport = { rows: rows.length, inserted: 0, skipped: 0, failed: 0 };

    for (const row of rows) {
      try {
        const outcome = await this.drainRow(row);
        report.inserted += outcome.inserted;
        report.skipped += outcome.skipped;
        await this.markDispatched(row);
      } catch (error) {
        report.failed += 1;
        await this.recordFailure(row, error, now);
      }
    }

    if (report.rows > 0) {
      this.logger.log({ message: 'Usage outbox drained', ...report });
    }
    return report;
  }

  /**
   * Rate, append and aggregate every event of one outbox row.
   *
   * Throws on any non-idempotency failure so the caller can apply backoff. A
   * partially-drained row is safe to re-run: the events that landed conflict on
   * their idempotency key and are skipped without touching the rollups.
   */
  private async drainRow(row: AiUsageOutboxEntity): Promise<{ inserted: number; skipped: number }> {
    const events = readPayload(row);
    let inserted = 0;
    let skipped = 0;

    for (const event of events) {
      const applied = await this.appendEvent(event);
      if (applied) inserted += 1;
      else skipped += 1;
    }

    return { inserted, skipped };
  }

  /**
   * One event: rate it, then append + aggregate atomically.
   *
   * @returns true when the event was newly appended, false when it was already
   *          recorded (and its rollup deltas therefore already applied).
   */
  private async appendEvent(event: SerializedUsageEvent): Promise<boolean> {
    const occurredAt = new Date(event.occurredAt);

    // RATING FAILS OPEN. An unresolvable price leaves the row unrated and
    // recorded; a missing rate can be repaired by back-rating from the raw
    // ledger later, a missing event cannot be repaired at all.
    const price = await this.priceBook.resolveCostPrice({
      tenantId: event.tenantId,
      capability: event.capability,
      unit: event.unit,
      provider: event.provider,
      model: event.model,
      contextBand: event.attributesJson?.contextBand ?? null,
      occurredAt,
    });

    const costMicros = price ? computeCostMicros(event.quantity, price.unitPriceMicros) : null;

    const entity = AiUsageEventFactory.CreateAiUsageEvent({
      tenantId: event.tenantId,
      idempotencyKey: event.idempotencyKey,
      occurredAt,
      capability: event.capability,
      operation: event.operation,
      provider: event.provider,
      model: event.model,
      deployment: event.deployment,
      unit: event.unit,
      quantity: event.quantity,
      consultationId: event.consultationId,
      doctorId: event.doctorId,
      departmentId: event.departmentId,
      requestId: event.requestId,
      sessionId: event.sessionId,
      // A resolved price of ZERO is a real rate, not a missing one — two seeded
      // rows are deliberately zero. Only an UNRESOLVED price leaves nulls here.
      unitPriceMicros: price ? price.unitPriceMicros : null,
      priceBookVersion: price ? price.bookVersion : null,
      costMicros,
      costBasis: event.costBasis,
      // Same structural-cast note as the outbox payload: the attribute bag is
      // allow-listed scalars only (`usage-attributes.ts`), which is narrower
      // than `JsonObject`, not wider.
      attributesJson: event.attributesJson as unknown as JsonObject | null,
    });

    // BYOK is metered and rated for the tenant's visibility but is NOT platform
    // spend, so it contributes nothing to the aggregates (D14). The stamped
    // `costMicros` on the raw row above is what surfaces notional spend.
    const costDelta = event.costBasis === AiCostBasis.BYOK_NOTIONAL ? 0n : (costMicros ?? 0n);

    try {
      await this.unitOfWork.runInTransaction(async (tx: CorePrisma.TransactionClient) => {
        await this.eventRepository.create(entity, tx);
        await this.accumulateRollups(event, occurredAt, costDelta, tx);
      });
      return true;
    } catch (error) {
      if (isIdempotencyKeyConflict(error)) return false;
      throw error;
    }
  }

  /** Hourly + daily increments on the SAME transaction as the append. */
  private async accumulateRollups(event: SerializedUsageEvent, occurredAt: Date, costDelta: bigint, tx: CorePrisma.TransactionClient): Promise<void> {
    const dimension = {
      tenantId: event.tenantId,
      capability: event.capability,
      provider: event.provider,
      // EMPTY-STRING SENTINEL, never null: Postgres treats each NULL as
      // distinct, so a nullable dimension would let two upserts for the same
      // model-less capability BOTH insert and silently double-count.
      model: event.model ?? '',
      unit: event.unit,
    };
    const quantity = new Decimal(event.quantity).toString();

    await this.hourlyRepository.accumulate({ ...dimension, bucketStart: truncateToHour(occurredAt) }, quantity, costDelta, generateId(), tx);
    await this.dailyRepository.accumulate({ ...dimension, bucketStart: truncateToDay(occurredAt) }, quantity, costDelta, generateId(), tx);
  }

  private async markDispatched(row: AiUsageOutboxEntity): Promise<void> {
    row.status = AiUsageOutboxStatus.DISPATCHED;
    row.lastError = null;
    await this.outboxRepository.update(row.id, row);
  }

  /**
   * Apply backoff, or park the row.
   *
   * A parked row is EVIDENCE, not garbage: it still holds the usage that never
   * made it to the ledger, so a human can replay it after fixing the cause.
   */
  private async recordFailure(row: AiUsageOutboxEntity, error: unknown, now: Date): Promise<void> {
    const attempts = row.attempts + 1;
    const permanent = isPermanentFailure(error) || attempts >= MAX_DRAIN_ATTEMPTS;

    row.attempts = attempts;
    row.lastError = describeError(error);
    row.status = permanent ? AiUsageOutboxStatus.FAILED : AiUsageOutboxStatus.PENDING;
    if (!permanent) {
      row.availableAt = new Date(now.getTime() + backoffMs(attempts));
    }

    this.logger[permanent ? 'error' : 'warn']({
      message: permanent ? 'Usage outbox row parked as FAILED' : 'Usage outbox row scheduled for retry',
      outboxId: row.id,
      tenantId: row.tenantId,
      attempts,
      lastError: row.lastError,
    });

    await this.outboxRepository.update(row.id, row);
  }
}

/** Marker for a fault that retrying cannot fix. */
class PermanentDrainError extends Error {}

function isPermanentFailure(error: unknown): boolean {
  return error instanceof PermanentDrainError;
}

/**
 * Read and shape-check the JSONB payload.
 *
 * An unrecognised `version` is PERMANENT: re-interpreting an unknown payload on
 * a guess is how a money pipeline invents numbers, and retrying it forever only
 * adds noise. Park it for a human.
 */
function readPayload(row: AiUsageOutboxEntity): SerializedUsageEvent[] {
  const payload = row.payload as unknown as UsageOutboxPayload | null;

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PermanentDrainError('Usage outbox payload is not an object');
  }
  if (payload.version !== USAGE_OUTBOX_PAYLOAD_VERSION) {
    throw new PermanentDrainError(`Unsupported usage outbox payload version ${String(payload.version)} (expected ${USAGE_OUTBOX_PAYLOAD_VERSION})`);
  }
  if (!Array.isArray(payload.events)) {
    throw new PermanentDrainError('Usage outbox payload carries no events array');
  }
  return payload.events;
}

/**
 * True only for a unique-constraint violation naming `idempotencyKey`.
 *
 * Duck-typed on `code`, mirroring `AiUsageEventRepository`'s own detector and
 * the rest of the codebase's Prisma-error handling. It is deliberately narrow:
 * a P2002 on some OTHER index, and every non-P2002 error, must retry rather
 * than be reported as "already recorded", which would silently drop usage.
 */
function isIdempotencyKeyConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return false;
  const target = candidate.meta?.target;
  if (Array.isArray(target)) return target.includes('idempotencyKey');
  if (typeof target === 'string') return target.includes('idempotencyKey');
  return false;
}

/** Exponential, capped. `attempts` is the attempt just consumed (1-based). */
function backoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempts - 1), RETRY_MAX_DELAY_MS);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, MAX_LAST_ERROR_LENGTH);
}

function truncateToHour(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours()));
}

function truncateToDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
