import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AiUsageOutboxEntity } from '../../../entities';
import { AiUsageOutboxStatus } from '../../../enums';
import { AiUsageOutboxEntityMapper } from '../../../mappers';
import { AiUsageOutbox } from '../../../models';

/**
 * Transactional-outbox repository for usage emission.
 *
 * Rows are WORK ITEMS, not history: append-only, no soft delete (drained rows
 * are pruned), no sys-events. The drainer's exactly-once-effective behaviour
 * comes from the LEDGER's unique `idempotencyKey`, not from anything here — this
 * table only has to guarantee at-least-once delivery.
 */
@Injectable()
export class AiUsageOutboxRepository extends Repository<AiUsageOutboxEntity, AiUsageOutbox> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'aiUsageOutbox', AiUsageOutboxEntityMapper.getInstance());
  }

  /**
   * The next batch of claimable work: PENDING rows whose backoff has elapsed,
   * oldest first.
   *
   * NOT tenant-filtered — the drainer is a platform job that sweeps every
   * tenant, the same posture as the metering reconcile job. It therefore runs
   * against the unscoped path with no CLS tenant; each row carries its own
   * `tenantId`, which the drainer stamps onto the ledger event it creates.
   */
  async findClaimable(limit: number, now: Date = new Date()): Promise<AiUsageOutboxEntity[]> {
    const models = await this.db.findMany({
      where: { status: AiUsageOutboxStatus.PENDING, availableAt: { lte: now } },
      orderBy: [{ availableAt: 'asc' }],
      take: limit,
    });
    const mapper = AiUsageOutboxEntityMapper.getInstance();
    return models.map((model: AiUsageOutbox) => mapper.toDomainEntity(model));
  }

  /**
   * Outbox rows still owed for a tenant — the "is anything stuck?" read behind
   * the shadow-metering drift report.
   */
  async findPendingForTenant(tenantId: string, tx?: Prisma.TransactionClient | any): Promise<AiUsageOutboxEntity[]> {
    const delegate = tx ? (tx as Record<string, any>).aiUsageOutbox : this.db;
    const models = await delegate.findMany({
      where: { tenantId, status: AiUsageOutboxStatus.PENDING },
      orderBy: [{ availableAt: 'asc' }],
    });
    const mapper = AiUsageOutboxEntityMapper.getInstance();
    return models.map((model: AiUsageOutbox) => mapper.toDomainEntity(model));
  }
}
