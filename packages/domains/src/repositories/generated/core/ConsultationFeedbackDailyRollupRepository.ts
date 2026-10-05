import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { ArgumentInvalidException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { removeNullValues } from '../../../common/removeNullValues';
import { ConsultationFeedbackDailyRollupEntityMapper } from '../../../mappers';
import { ConsultationFeedbackDailyRollupEntity } from '../../../entities';
import { ConsultationFeedbackDailyRollup } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { FeedbackTargetKind } from '../../../enums';

/**
 * Derived per-day feedback aggregate. A day is recomputed as a whole:
 * {@link replaceDay} deletes the (tenant, day) rows and inserts the fresh set
 * (a real delete — the rows are derived and carry no `resourceStatus`).
 */
@Injectable()
export class ConsultationFeedbackDailyRollupRepository extends Repository<ConsultationFeedbackDailyRollupEntity, ConsultationFeedbackDailyRollup> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'consultationFeedbackDailyRollup', ConsultationFeedbackDailyRollupEntityMapper.getInstance());
  }

  /**
   * Replace every rollup row of `(tenantId, day)` with `rows`. Pass the
   * caller's transaction so the delete and the insert commit together. Every
   * row must belong to the same tenant and day.
   */
  async replaceDay(
    tenantId: string,
    day: Date,
    rows: ConsultationFeedbackDailyRollupEntity[],
    tx?: Prisma.TransactionClient | any,
  ): Promise<{ deleted: number; inserted: number }> {
    for (const row of rows) {
      if (row.tenantId !== tenantId || row.day.getTime() !== day.getTime()) {
        throw new ArgumentInvalidException('replaceDay: every row must belong to the replaced tenant and day');
      }
    }
    const delegate = tx ? (tx as Record<string, any>).consultationFeedbackDailyRollup : (this as any).db;
    const mapper = (this as any)._mapper as ConsultationFeedbackDailyRollupEntityMapper;

    const deleted = await delegate.deleteMany({ where: { tenantId, day } });
    if (rows.length === 0) return { deleted: deleted.count, inserted: 0 };
    const inserted = await delegate.createMany({ data: rows.map((row) => removeNullValues(mapper.toPersistence(row))) });
    return { deleted: deleted.count, inserted: inserted.count };
  }

  /** The tenant's rollup rows for days in `[from, to]`, optionally of one target kind. */
  async findRange(tenantId: string, from: Date, to: Date, targetKind?: FeedbackTargetKind): Promise<ConsultationFeedbackDailyRollupEntity[]> {
    const models = await (this as any).db.findMany({
      where: { tenantId, day: { gte: from, lte: to }, ...(targetKind ? { targetKind } : {}) },
      orderBy: [{ day: 'asc' }],
    });
    return models.map((model: ConsultationFeedbackDailyRollup) => (this as any)._mapper.toDomainEntity(model));
  }
}
