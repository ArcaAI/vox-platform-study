import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { CoreUnitOfWorkService } from '../../common/unitsOfWork/core';
import { AiCapability } from '../../enums';

/**
 * Bounded SQL aggregates over the raw usage ledger for the usage-analytics
 * surface.
 *
 * These two queries exist because neither the daily/hourly rollups nor the
 * generated `AiUsageEventRepository` can express them:
 *   - `sumCostPerConsultation` groups by `consultationId` — a dimension the
 *     rollup tuple does not carry (mirrors `BillingUsageAggregateRepository`'s
 *     rationale) — and is the source distribution for
 *     `getCostPerEncounter`'s p50/p90/p99.
 *   - `topTenantsByCost` / `sumByokNotionalByCapability` need to run WITHOUT a
 *     `tenantId` filter, or grouped BY `tenantId`, which the tenant-scoped
 *     `$extends` on every generated repository cannot do. This is the same
 *     sanctioned cross-tenant bypass `MeteringService.reconcileAllActiveTenants`
 *     uses (`baseClient`/unscoped raw SQL) — gated at the HTTP layer by
 *     SUPER_ADMIN (`@CanManage`) and imperatively in the service
 *     (`isSuperAdmin`), never exposed to a tenant-scoped caller.
 *
 * RAW SQL NOTES: every dimension is a BOUND PARAMETER (`Prisma.sql`), never
 * interpolated. `AiUsageEvent`/`AiUsageRollupDaily` have no soft-delete
 * lifecycle, so there is no `resourceStatus` filter to add.
 */

export interface ConsultationCostSum {
  consultationId: string;
  costMicros: bigint;
}

export interface TenantCostSum {
  tenantId: string;
  costMicros: bigint;
}

export interface CapabilityCostSum {
  capability: AiCapability;
  costMicros: bigint;
}

@Injectable()
export class UsageAnalyticsAggregateRepository {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {}

  // The extended client (or in-flight tx) — carries `$queryRaw`.
  private get client(): { $queryRaw: (query: unknown) => Promise<unknown> } {
    return this.unitOfWorkService.getDatabaseService() as unknown as { $queryRaw: (query: unknown) => Promise<unknown> };
  }

  /**
   * Σ `costMicros` per `consultationId` for one tenant's INTERNAL-basis usage
   * in `[from, to)`. `consultationId IS NULL` rows (harness steps, backfills)
   * are excluded — they cannot be attributed to an encounter. BYOK_NOTIONAL is
   * excluded too: it is never platform cost, so it would inflate the
   * distribution with spend the platform never incurred.
   */
  async sumCostPerConsultation(tenantId: string, from: Date, to: Date): Promise<ConsultationCostSum[]> {
    const rows = (await this.client.$queryRaw(Prisma.sql`
      SELECT "consultationId" AS "consultationId",
             SUM("costMicros") AS "costMicros"
      FROM "core"."AiUsageEvent"
      WHERE "tenantId" = ${tenantId}
        AND "consultationId" IS NOT NULL
        AND "costBasis" = CAST('INTERNAL' AS "core"."AiCostBasis")
        AND "costMicros" IS NOT NULL
        AND "occurredAt" >= ${from}
        AND "occurredAt" < ${to}
      GROUP BY 1
      ORDER BY 1
    `)) as Array<{ consultationId: string; costMicros: unknown }>;

    return rows.map((row) => ({ consultationId: row.consultationId, costMicros: row.costMicros === null ? 0n : BigInt(String(row.costMicros)) }));
  }

  /**
   * Cross-tenant top-N by total rollup cost in `[from, to)`.
   *
   * DELIBERATE cross-tenant bypass — see the class header. `capability` is an
   * optional narrowing filter (e.g. "top tenants by LLM spend"); omitted sums
   * across every capability.
   */
  async topTenantsByCost(from: Date, to: Date, limit: number, capability?: AiCapability): Promise<TenantCostSum[]> {
    const capabilityFilter = capability ? Prisma.sql`AND "capability" = CAST(${capability} AS "core"."AiCapability")` : Prisma.empty;
    const rows = (await this.client.$queryRaw(Prisma.sql`
      SELECT "tenantId" AS "tenantId",
             SUM("costMicrosSum") AS "costMicros"
      FROM "core"."AiUsageRollupDaily"
      WHERE "bucketStart" >= ${from}
        AND "bucketStart" < ${to}
        ${capabilityFilter}
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT ${limit}
    `)) as Array<{ tenantId: string; costMicros: unknown }>;

    return rows.map((row) => ({ tenantId: row.tenantId, costMicros: row.costMicros === null ? 0n : BigInt(String(row.costMicros)) }));
  }

  /** Σ `costMicros` of BYOK_NOTIONAL events, grouped by capability, for one tenant in `[from, to)`. */
  async sumByokNotionalByCapability(tenantId: string, from: Date, to: Date): Promise<CapabilityCostSum[]> {
    const rows = (await this.client.$queryRaw(Prisma.sql`
      SELECT "capability"::text AS "capability",
             SUM("costMicros") AS "costMicros"
      FROM "core"."AiUsageEvent"
      WHERE "tenantId" = ${tenantId}
        AND "costBasis" = CAST('BYOK_NOTIONAL' AS "core"."AiCostBasis")
        AND "occurredAt" >= ${from}
        AND "occurredAt" < ${to}
      GROUP BY 1
      ORDER BY 1
    `)) as Array<{ capability: string; costMicros: unknown }>;

    return rows.map((row) => ({
      capability: row.capability as AiCapability,
      costMicros: row.costMicros === null ? 0n : BigInt(String(row.costMicros)),
    }));
  }
}
