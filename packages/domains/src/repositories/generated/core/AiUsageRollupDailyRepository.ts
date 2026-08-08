import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AiUsageRollupDailyEntity } from '../../../entities';
import { AiCapability, AiDeploymentKind, AiUsageUnit } from '../../../enums';
import { AiUsageRollupDailyEntityMapper } from '../../../mappers';
import { AiUsageRollupDaily } from '../../../models';

/** The full UNIQUE dimension tuple of one daily rollup bucket. */
export interface AiUsageRollupDailyDimension {
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
 * Daily pre-aggregate repository.
 *
 * Append-only: no soft delete (rollups are retained indefinitely and corrected
 * by re-aggregation, not deletion), no sys-events.
 *
 * The dimension tuple is UNIQUE in the schema, which is what makes maintenance
 * an idempotent upsert under drainer retry — see {@link accumulate}.
 */
@Injectable()
export class AiUsageRollupDailyRepository extends Repository<AiUsageRollupDailyEntity, AiUsageRollupDaily> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'aiUsageRollupDaily', AiUsageRollupDailyEntityMapper.getInstance());
  }

  /** The bucket at this exact dimension tuple, or null. */
  async findByDimension(dimension: AiUsageRollupDailyDimension, tx?: Prisma.TransactionClient | any): Promise<AiUsageRollupDailyEntity | null> {
    const delegate = tx ? (tx as Record<string, any>).aiUsageRollupDaily : this.db;
    const model = await delegate.findFirst({ where: { ...dimension } });
    return model ? AiUsageRollupDailyEntityMapper.getInstance().toDomainEntity(model) : null;
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
    dimension: AiUsageRollupDailyDimension,
    quantityDelta: Prisma.Decimal | number | string,
    costMicrosDelta: bigint,
    id: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiUsageRollupDailyEntity> {
    const delegate = tx ? (tx as Record<string, any>).aiUsageRollupDaily : this.db;
    const now = new Date();
    const model = await delegate.upsert({
      where: { AiUsageRollupDaily_dimension_unique: { ...dimension } },
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
    return AiUsageRollupDailyEntityMapper.getInstance().toDomainEntity(model);
  }

  /**
   * Every bucket of a tenant in [from, to), ordered.
   *
   * Half-open so consecutive periods neither overlap nor drop a bucket on the
   * boundary — the read behind month-to-date consumption and invoice
   * computation (which reads ROLLUPS, never raw events).
   */
  async findByPeriod(tenantId: string, from: Date, to: Date): Promise<AiUsageRollupDailyEntity[]> {
    const models = await this.db.findMany({
      where: { tenantId, bucketStart: { gte: from, lt: to } },
      orderBy: [{ bucketStart: 'asc' }],
    });
    const mapper = AiUsageRollupDailyEntityMapper.getInstance();
    return models.map((model: AiUsageRollupDaily) => mapper.toDomainEntity(model));
  }

  /**
   * All-time `quantitySum` for one (capability, unit-set) of a tenant, as a
   * `number` (TASK-615 #11 — the ledger-derived consumption read behind
   * `PlatformMetricsService.getConsumptionRollup`, so the platform-metrics
   * dashboard agrees with `UsageAnalyticsService.getUsageSummary`). Pass
   * `tenantId = null` for the platform-wide total. Returns 0 when no rows match.
   */
  async sumQuantityForCapabilityUnits(tenantId: string | null, capability: AiCapability, units: AiUsageUnit[]): Promise<number> {
    const result = await this.db.aggregate({
      _sum: { quantitySum: true },
      where: { ...(tenantId ? { tenantId } : {}), capability, unit: { in: units } },
    });
    const sum = result._sum?.quantitySum ?? null;
    if (sum === null || sum === undefined) return 0;
    return typeof sum === 'object' && typeof (sum as { toNumber?: unknown }).toNumber === 'function'
      ? (sum as { toNumber: () => number }).toNumber()
      : Number(sum);
  }
}
