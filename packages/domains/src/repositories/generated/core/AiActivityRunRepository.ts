import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { removeNullValues } from '../../../common/removeNullValues';
import { AiActivityRunEntityMapper } from '../../../mappers';
import { AiActivityRunEntity } from '../../../entities';
import { AiActivityRun } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/** Columns a replayed upsert never rewrites — the record's identity. */
const UPSERT_IMMUTABLE = ['id', 'tenantId', 'runKey', 'createdAt', 'createdBy'];

/** Lookup for {@link AiActivityRunRepository.findProducerOf}. */
export interface ActivityRunProducerQuery {
  tenantId: string;
  contextItemId: string;
  /** Exact produced version; omitted = the newest producing run of the item. */
  versionNumber?: number | null;
  consultationId?: string;
}

/**
 * Durable per-AI-activity run records. Append-only telemetry (ids, enums and
 * numbers only): no soft delete and no sys-events. Writes are idempotent on
 * `runKey` via {@link upsertByRunKey}.
 */
@Injectable()
export class AiActivityRunRepository extends Repository<AiActivityRunEntity, AiActivityRun> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'aiActivityRun', AiActivityRunEntityMapper.getInstance());
  }

  /**
   * Insert the run, or — when its `runKey` already exists — update the run's
   * outcome columns in place (identity columns never move). A replayed
   * producer therefore leaves exactly one row per `runKey`.
   */
  async upsertByRunKey(entity: AiActivityRunEntity, tx?: Prisma.TransactionClient | any): Promise<AiActivityRunEntity> {
    const delegate = tx ? (tx as Record<string, any>).aiActivityRun : (this as any).db;
    const mapper = (this as any)._mapper as AiActivityRunEntityMapper;
    const create = removeNullValues(mapper.toPersistence(entity)) as Record<string, unknown>;
    const update: Record<string, unknown> = { ...create };
    for (const key of UPSERT_IMMUTABLE) delete update[key];

    const model = await delegate.upsert({ where: { runKey: entity.runKey }, create, update });
    return mapper.toDomainEntity(model);
  }

  /** One record by its idempotency key, or `null`. */
  async findByRunKey(runKey: string): Promise<AiActivityRunEntity | null> {
    const model = await (this as any).db.findFirst({ where: { runKey } });
    return model ? (this as any)._mapper.toDomainEntity(model) : null;
  }

  /** Every run of a consultation in start order. */
  async findByConsultation(tenantId: string, consultationId: string): Promise<AiActivityRunEntity[]> {
    const models = await (this as any).db.findMany({
      where: { tenantId, consultationId },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    });
    return models.map((model: AiActivityRun) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * The run that produced an item version: an exact `(contextItemId,
   * outputVersionNumber)` match when `versionNumber` is given, otherwise the
   * newest producing run of the item. `null` when no run recorded it.
   */
  async findProducerOf(query: ActivityRunProducerQuery): Promise<AiActivityRunEntity | null> {
    const where: Record<string, unknown> = { tenantId: query.tenantId, contextItemId: query.contextItemId };
    if (query.versionNumber !== undefined && query.versionNumber !== null) where.outputVersionNumber = query.versionNumber;
    if (query.consultationId) where.consultationId = query.consultationId;
    const model = await (this as any).db.findFirst({
      where,
      orderBy: [{ outputVersionNumber: 'desc' }, { startedAt: 'desc' }],
    });
    return model ? (this as any)._mapper.toDomainEntity(model) : null;
  }
}
