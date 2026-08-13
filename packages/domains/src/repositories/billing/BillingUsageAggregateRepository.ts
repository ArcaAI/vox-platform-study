import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@arcaai/database';

import { CoreUnitOfWorkService } from '../../common/unitsOfWork/core';
import { AiCapability, AiDeploymentKind, AiUsageUnit } from '../../enums';

/**
 * Bounded SQL aggregates over the raw usage ledger for the invoice engine.
 *
 * Reading raw EVENTS at invoice time is forbidden — that rule exists so a busy
 * tenant's invoice never fans out over millions of rows. These two queries are
 * SUMS pushed into Postgres (one aggregate row per day×unit×operation, riding
 * `AiUsageEvent_tenant_capability_occurredAt_idx`), which is the same shape a
 * rollup read has. They exist because the rollup dimension tuple carries no
 * `operation` and no `costBasis`:
 *
 *   - `sumDailyQuantitiesByOperation` — the guardrail/harness-never-billed
 *     and batch-only audio-seconds compensation terms.
 *   - `sumByokNotionalCostMicros` — the tenant's notional BYOK spend,
 *     surfaced on the invoice DTO as a product feature, never as a line.
 *
 * Both become plain rollup reads if/when the rollup grain grows an `operation`
 * (or `billable`) dimension — flagged as a follow-up migration.
 *
 * RAW SQL NOTES: every dimension is a BOUND PARAMETER (`Prisma.sql`), never
 * interpolated; `tenantId` is an explicit predicate because `$queryRaw`
 * bypasses the tenant-scope `$extends`. `AiUsageEvent` has no soft-delete
 * lifecycle, so there is no `resourceStatus` filter to add.
 */

export interface OperationDayUnitSum {
  /** UTC day bucket (date_trunc('day')). */
  day: Date;
  unit: AiUsageUnit;
  operation: string;
  /**
   * Funding + vendor of the compensated usage. These sums are
   * SUBTRACTED FROM or REPLACE rollup buckets that are themselves keyed by
   * (provider, deployment), so the compensation must carry the same dimensions
   * or it would deduct one provider's usage from another's bucket — and the
   * SELF_HOSTED-first allowance ordering would be computed on wrong quantities.
   */
  provider: string;
  deployment: AiDeploymentKind;
  quantity: Decimal;
}

export interface SumDailyQuantitiesByOperationQuery {
  tenantId: string;
  capability: AiCapability;
  operations: readonly string[];
  /** Half-open [from, to) on `occurredAt` — the same boundary the rollups use. */
  from: Date;
  to: Date;
}

@Injectable()
export class BillingUsageAggregateRepository {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {}

  // The extended client (or in-flight tx) — carries `$queryRaw`.
  private get client(): { $queryRaw: (query: unknown) => Promise<unknown> } {
    return this.unitOfWorkService.getDatabaseService() as unknown as { $queryRaw: (query: unknown) => Promise<unknown> };
  }

  /** Per-(UTC day, unit, operation, provider, deployment) quantity sums for one capability and period. */
  async sumDailyQuantitiesByOperation(query: SumDailyQuantitiesByOperationQuery): Promise<OperationDayUnitSum[]> {
    if (query.operations.length === 0) return [];

    const rows = (await this.client.$queryRaw(Prisma.sql`
      SELECT date_trunc('day', "occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS "day",
             "unit"::text                                                          AS "unit",
             "operation"                                                           AS "operation",
             "provider"                                                            AS "provider",
             "deployment"::text                                                    AS "deployment",
             SUM("quantity")                                                       AS "quantity"
      FROM "core"."AiUsageEvent"
      WHERE "tenantId" = ${query.tenantId}
        AND "capability" = CAST(${query.capability} AS "core"."AiCapability")
        AND "operation" IN (${Prisma.join([...query.operations])})
        AND "occurredAt" >= ${query.from}
        AND "occurredAt" < ${query.to}
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY 1, 2, 3, 4, 5
    `)) as Array<{ day: Date; unit: string; operation: string; provider: string; deployment: string; quantity: unknown }>;

    return rows.map((row) => ({
      day: new Date(row.day),
      unit: row.unit as AiUsageUnit,
      operation: row.operation,
      provider: row.provider,
      deployment: row.deployment as AiDeploymentKind,
      // Postgres NUMERIC arrives as a driver-specific decimal/string — route
      // through Decimal so no float ever touches a billable quantity.
      quantity: new Decimal(String(row.quantity)),
    }));
  }

  /**
   * Σ `costMicros` of the tenant's BYOK_NOTIONAL events in [from, to).
   * NULL (no BYOK rows, or all unrated) degrades to 0n.
   */
  async sumByokNotionalCostMicros(tenantId: string, from: Date, to: Date): Promise<bigint> {
    const rows = (await this.client.$queryRaw(Prisma.sql`
      SELECT SUM("costMicros") AS "sum"
      FROM "core"."AiUsageEvent"
      WHERE "tenantId" = ${tenantId}
        AND "costBasis" = CAST('BYOK_NOTIONAL' AS "core"."AiCostBasis")
        AND "occurredAt" >= ${from}
        AND "occurredAt" < ${to}
    `)) as Array<{ sum: unknown }>;

    const sum = rows[0]?.sum;
    return sum === null || sum === undefined ? 0n : BigInt(String(sum));
  }
}
