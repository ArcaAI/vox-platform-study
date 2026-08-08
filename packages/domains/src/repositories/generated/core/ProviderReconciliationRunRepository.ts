import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ProviderReconciliationRunEntity } from '../../../entities';
import { ProviderReconciliationRunEntityMapper } from '../../../mappers';
import { ProviderReconciliationRun } from '../../../models';

/** One page of the audit report, newest first. */
export interface ProviderReconciliationRunQuery {
  /** Restrict to one vendor. */
  provider?: string;
  /** Only runs that breached the drift threshold — the "what needs investigating" view. */
  breachedOnly?: boolean;
  /** Half-open `runAt` filter. */
  from?: Date;
  to?: Date;
  limit?: number;
}

/**
 * Provider-reconciliation audit trail (TASK-638 §6 rule 6).
 *
 * APPEND-ONLY: this repository deliberately exposes no update and no delete.
 * `softDelete()`/`restore()` inherited from the base throw for this model
 * (MODELS_WITHOUT_SOFT_DELETE), and that is the point — a control that can be
 * rewritten after the fact answers nothing in a dispute.
 */
@Injectable()
export class ProviderReconciliationRunRepository extends Repository<ProviderReconciliationRunEntity, ProviderReconciliationRun> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'providerReconciliationRun', ProviderReconciliationRunEntityMapper.getInstance());
  }

  /**
   * The audit report: newest first, optionally narrowed to one vendor, a period,
   * or only the breaches.
   *
   * Capped at 500 rows. An unbounded audit read is a foot-gun on a table that
   * grows one row per provider per day forever.
   */
  async findRuns(query: ProviderReconciliationRunQuery = {}, tx?: Prisma.TransactionClient | any): Promise<ProviderReconciliationRunEntity[]> {
    const delegate = tx ? (tx as Record<string, any>).providerReconciliationRun : this.db;
    const where: Record<string, unknown> = {};
    if (query.provider) where.provider = query.provider;
    if (query.breachedOnly) where.breachedThreshold = true;
    if (query.from || query.to) {
      where.runAt = { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) };
    }

    const models = await delegate.findMany({
      where,
      orderBy: [{ runAt: 'desc' }, { provider: 'asc' }],
      take: Math.min(Math.max(query.limit ?? 100, 1), 500),
    });
    const mapper = ProviderReconciliationRunEntityMapper.getInstance();
    return models.map((model: ProviderReconciliationRun) => mapper.toDomainEntity(model));
  }

  /** The most recent run per provider — what a status board shows. */
  async findLatestPerProvider(tx?: Prisma.TransactionClient | any): Promise<ProviderReconciliationRunEntity[]> {
    const recent = await this.findRuns({ limit: 500 }, tx);
    const seen = new Set<string>();
    return recent.filter((run) => {
      if (seen.has(run.provider)) return false;
      seen.add(run.provider);
      return true;
    });
  }
}
