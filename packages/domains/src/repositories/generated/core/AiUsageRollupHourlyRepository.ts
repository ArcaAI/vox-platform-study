import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AiUsageRollupHourlyEntity } from '../../../entities';
import { AiCapability, AiDeploymentKind, AiUsageUnit } from '../../../enums';
import { AiUsageRollupHourlyEntityMapper } from '../../../mappers';
import { AiUsageRollupHourly } from '../../../models';

/** The full UNIQUE dimension tuple of one hourly rollup bucket. */
export interface AiUsageRollupHourlyDimension {
  tenantId: string;
  bucketStart: Date;
  capability: AiCapability;
  /** Ledger event operation (TASK-615 #4); "" sentinel for pre-follow-up rows. */
  operation: string;
  provider: string;
  /** Who FUNDED the call (TASK-638) — the allowance is consumed SELF_HOSTED-first. */
  deployment: AiDeploymentKind;
  /** "" sentinel when the capability selects no model — never null. */
  model: string;
  unit: AiUsageUnit;
}

/**
 * Hourly pre-aggregate repository.
 *
 * Append-only: no soft delete (rollups are retained indefinitely and corrected
 * by re-aggregation, not deletion), no sys-events.
 *
 * The dimension tuple is UNIQUE in the schema, which is what makes maintenance
 * an idempotent upsert under drainer retry — see {@link accumulate}.
 */
@Injectable()
export class AiUsageRollupHourlyRepository extends Repository<AiUsageRollupHourlyEntity, AiUsageRollupHourly> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'aiUsageRollupHourly', AiUsageRollupHourlyEntityMapper.getInstance());
  }

  /** The bucket at this exact dimension tuple, or null. */
  async findByDimension(dimension: AiUsageRollupHourlyDimension, tx?: Prisma.TransactionClient | any): Promise<AiUsageRollupHourlyEntity | null> {
    const delegate = tx ? (tx as Record<string, any>).aiUsageRollupHourly : this.db;
    const model = await delegate.findFirst({ where: { ...dimension } });
    return model ? AiUsageRollupHourlyEntityMapper.getInstance().toDomainEntity(model) : null;
  }

  /**
   * Add a quantity/cost delta into the bucket, creating it if absent.
   *
   * A single atomic UPSERT on the unique dimension tuple, with the update branch
   * expressed as Prisma `increment` operations so concurrent drainer workers
   * accumulate correctly: the arithmetic happens IN THE DATABASE, never as a
   * read-modify-write in application memory, which would lose updates under
   * exactly the concurrency this table sees.
   *
   * `id` is supplied by the caller (a UUIDv7 from the factory) and used on the
   * create branch only.
   */
  async accumulate(
    dimension: AiUsageRollupHourlyDimension,
    quantityDelta: Prisma.Decimal | number | string,
    costMicrosDelta: bigint,
    id: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiUsageRollupHourlyEntity> {
    const delegate = tx ? (tx as Record<string, any>).aiUsageRollupHourly : this.db;
    const now = new Date();
    const model = await delegate.upsert({
      where: { AiUsageRollupHourly_dimension_unique: { ...dimension } },
      create: {
        id,
        ...dimension,
        quantitySum: quantityDelta,
        costMicrosSum: costMicrosDelta,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        quantitySum: { increment: quantityDelta },
        costMicrosSum: { increment: costMicrosDelta },
      },
    });
    return AiUsageRollupHourlyEntityMapper.getInstance().toDomainEntity(model);
  }

  /**
   * Every bucket of a tenant in [from, to), ordered.
   *
   * Half-open so consecutive periods neither overlap nor drop a bucket on the
   * boundary — the read behind month-to-date consumption and invoice
   * computation (which reads ROLLUPS, never raw events).
   */
  async findByPeriod(tenantId: string, from: Date, to: Date): Promise<AiUsageRollupHourlyEntity[]> {
    const models = await this.db.findMany({
      where: { tenantId, bucketStart: { gte: from, lt: to } },
      orderBy: [{ bucketStart: 'asc' }],
    });
    const mapper = AiUsageRollupHourlyEntityMapper.getInstance();
    return models.map((model: AiUsageRollupHourly) => mapper.toDomainEntity(model));
  }
}
