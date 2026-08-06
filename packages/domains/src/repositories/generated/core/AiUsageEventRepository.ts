import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AiUsageEventEntity } from '../../../entities';
import { AiUsageEventEntityMapper } from '../../../mappers';
import { AiUsageEvent } from '../../../models';

/** Outcome of {@link AiUsageEventRepository.createIfAbsent}. */
export interface AppendUsageEventResult {
  entity: AiUsageEventEntity;
  /** false when an equivalent event was already recorded (idempotent replay). */
  created: boolean;
}

/**
 * Append-only usage-ledger repository.
 *
 * `AiUsageEvent` is TENANT-SCOPED metering truth. Its posture is DELIBERATELY
 * exempt from two platform conventions (the `AgentTrajectoryStep` precedent):
 *   - SOFT-DELETE: the model is in MODELS_WITHOUT_SOFT_DELETE and has no
 *     `resourceStatus` column, so `softDelete()`/`restore()` throw. Rows are
 *     hard-pruned by retention (18 months); a usage fact is corrected by a
 *     compensating event, never by deletion.
 *   - SYS-EVENTS: writes emit none — per-call metering at request volume would
 *     flood the audit trail with rows carrying no compliance meaning.
 *
 * There is no update surface beyond the inherited OCC `updateWithVersion`:
 * appending is the only mutation this table is meant to see.
 *
 * Cross-tenant isolation is enforced upstream by the shared tenant-scope
 * `$extends`; every finder here is additionally scoped by an explicit
 * `tenantId` filter.
 */
@Injectable()
export class AiUsageEventRepository extends Repository<AiUsageEventEntity, AiUsageEvent> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'aiUsageEvent', AiUsageEventEntityMapper.getInstance());
  }

  /**
   * Append a usage event, tolerating an idempotency-key collision as a NO-OP.
   *
   * This is THE anti-double-billing path. A retried emission — outbox
   * redelivery, gateway retry, a resumed stream — races into the unique index on
   * `idempotencyKey`; instead of surfacing that as an error (which would make
   * the drainer retry forever) or swallowing it blindly (which would hide real
   * failures), the conflict is resolved by re-reading the row that won and
   * reporting `created: false`.
   *
   * ONLY a P2002 on `idempotencyKey` is treated this way. Any other P2002, and
   * every non-P2002 failure, is rethrown: reporting a connection error as
   * "already recorded" would silently drop usage, which is the one outcome this
   * table exists to prevent.
   *
   * When a transaction client is supplied the append participates in the
   * caller's `$transaction` (mirrors the `create(..., tx)` contract), so a
   * business write and its usage row commit together.
   */
  async createIfAbsent(entity: AiUsageEventEntity, tx?: Prisma.TransactionClient | any): Promise<AppendUsageEventResult> {
    try {
      return { entity: await this.create(entity, tx), created: true };
    } catch (err) {
      if (!isIdempotencyKeyConflict(err)) {
        throw err;
      }
      const existing = await this.findByIdempotencyKey(entity.tenantId, entity.idempotencyKey, tx);
      if (!existing) {
        // The unique index fired but the row is not visible to us. That is not a
        // benign replay: it means the winning row belongs to a DIFFERENT tenant
        // (keys are global) or was written and pruned mid-flight. Surface the
        // original error rather than inventing a success.
        throw err;
      }
      return { entity: existing, created: false };
    }
  }

  /**
   * The event carrying this idempotency key WITHIN the given tenant, or null.
   *
   * Pinned to `(tenantId, idempotencyKey)` rather than the key alone: the unique
   * index is platform-wide, so a key-only read could return another tenant's row
   * and leak its usage across the boundary.
   */
  async findByIdempotencyKey(tenantId: string, idempotencyKey: string, tx?: Prisma.TransactionClient | any): Promise<AiUsageEventEntity | null> {
    const where = { tenantId, idempotencyKey };
    const delegate = tx ? (tx as Record<string, any>).aiUsageEvent : this.db;
    const model = await delegate.findFirst({ where });
    return model ? AiUsageEventEntityMapper.getInstance().toDomainEntity(model) : null;
  }

  /**
   * Every unit row of ONE provider call, ordered by occurrence.
   *
   * A single LLM call is several rows (input / output / cache / reasoning
   * tokens) sharing a `requestId` — this is how cost-per-request and
   * per-request reconciliation reassemble them.
   */
  async findByRequestId(tenantId: string, requestId: string): Promise<AiUsageEventEntity[]> {
    const models = await this.db.findMany({
      where: { tenantId, requestId },
      orderBy: [{ occurredAt: 'asc' }],
    });
    const mapper = AiUsageEventEntityMapper.getInstance();
    return models.map((model: AiUsageEvent) => mapper.toDomainEntity(model));
  }

  /**
   * Every event of a tenant whose `occurredAt` falls in [from, to), ordered.
   *
   * Half-open on purpose so consecutive periods neither overlap nor drop an
   * event on the boundary. Filters on `occurredAt` — NOT `recordedAt` — so a
   * backfilled event lands in the period it actually belongs to.
   */
  async findByPeriod(tenantId: string, from: Date, to: Date): Promise<AiUsageEventEntity[]> {
    const models = await this.db.findMany({
      where: { tenantId, occurredAt: { gte: from, lt: to } },
      orderBy: [{ occurredAt: 'asc' }],
    });
    const mapper = AiUsageEventEntityMapper.getInstance();
    return models.map((model: AiUsageEvent) => mapper.toDomainEntity(model));
  }
}

/**
 * True only for a unique-constraint violation naming `idempotencyKey`.
 *
 * Duck-typed on `code` rather than `instanceof PrismaClientKnownRequestError`,
 * matching how the rest of the codebase inspects Prisma errors (see
 * `apps/api/src/filters/prisma.filter.ts`) and keeping the check working under
 * mocked delegates in unit tests.
 */
function isIdempotencyKeyConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return false;
  const target = candidate.meta?.target;
  if (Array.isArray(target)) return target.includes('idempotencyKey');
  if (typeof target === 'string') return target.includes('idempotencyKey');
  // A P2002 with no usable target could be any unique index on the table —
  // never assume it was ours.
  return false;
}
