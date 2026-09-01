import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AiRoutingPolicyEntity } from '../../../entities';
import { AiRoutingPolicyStatus, ResourceStatusType } from '../../../enums';
import { AiRoutingPolicyEntityMapper } from '../../../mappers';
import { AiRoutingPolicy } from '../../../models';

/**
 * Provider routing policies (TASK-818 §3A.3).
 *
 * One row per (tenant, taskKey, policyVersion) — enforced by the
 * `AiRoutingPolicy_tenantId_taskKey_policyVersion_unique` index. The reserved
 * SYSTEM tenant row is the platform default. `AiRoutingPolicy` is a
 * SYSTEM-shared read model, so the tenant-scope extension permits pinning
 * `tenantId` to either the caller OR the SYSTEM tenant (mirrors
 * `AiTaskDefaultRepository`); the tenant → SYSTEM cascade itself, the
 * most-specific-match rules and the §3A.4 gates are resolved in the
 * application service, not here.
 */
@Injectable()
export class AiRoutingPolicyRepository extends Repository<AiRoutingPolicyEntity, AiRoutingPolicy> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'aiRoutingPolicy', AiRoutingPolicyEntityMapper.getInstance());
  }

  /**
   * The ACTIVE policy owned EXACTLY by `(tenantId, taskKey)` (no SYSTEM
   * fallback — the caller owns the cascade), ENABLED only, or null when that
   * tenant has authored no live policy for the task.
   *
   * Highest `policyVersion` wins: the supersede-only lifecycle can leave more
   * than one ACTIVE row addressable during a promotion, and the newest
   * authored revision is the one that serves. When a transaction client is
   * supplied the read participates in the caller's `$transaction` (mirrors the
   * `create(..., tx)` / `updateWithVersion(..., tx)` contract).
   */
  async findActiveByTenantAndTaskKey(tenantId: string, taskKey: string, tx?: Prisma.TransactionClient | any): Promise<AiRoutingPolicyEntity | null> {
    const where = {
      tenantId,
      taskKey,
      status: AiRoutingPolicyStatus.ACTIVE,
      resourceStatus: ResourceStatusType.ENABLED,
    };
    // `IFindAllProps.sort` is an ARRAY of single-key order clauses; the raw
    // Prisma `orderBy` on the tx path takes the object form.
    const sort = [{ policyVersion: 'desc' as const }];

    if (tx) {
      const model = await (tx as Record<string, any>).aiRoutingPolicy.findFirst({ where, orderBy: { policyVersion: 'desc' } });
      return model ? AiRoutingPolicyEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where, sort });
    } catch (err) {
      // Only a genuine miss maps to null. Anything else — most importantly the
      // tenant-scope extension's `TenantScope: tenantId mismatch` throw on a
      // cross-tenant read — must SURFACE rather than look like "no policy",
      // which would silently fail the request open to the SYSTEM default.
      // Same reasoning as `AiTaskDefaultRepository.findByTenantAndTaskKey`.
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }

  /**
   * TASK-844 — the ORDERED CANDIDATE CHAIN for one selection, across the tiers
   * the caller names.
   *
   * `tenantIds` is passed in rather than derived here on purpose: the two-tier
   * `[requestTenant, SYSTEM]` cascade is the application service's decision and
   * belongs where it can be read next to the widening rule it implements. This
   * method must never add a tier of its own — in particular it must never
   * append the Global customer tenant `50000000-…`.
   *
   * Ordering is `priority ASC` (lower serves first), then `policyVersion DESC`
   * so the newest authored revision wins a tie. The ELECTED default is picked
   * out by the service, not by this ordering, because `isDefault` outranks
   * `priority`.
   */
  async findCandidates(
    tenantIds: string[],
    taskKey: string,
    tx?: Prisma.TransactionClient | any,
    options: { activeOnly?: boolean; enabledOnly?: boolean } = {},
  ): Promise<AiRoutingPolicyEntity[]> {
    const { activeOnly = true, enabledOnly = true } = options;
    const where: Record<string, unknown> = {
      tenantId: { in: tenantIds },
      taskKey,
      resourceStatus: ResourceStatusType.ENABLED,
    };
    if (activeOnly) where.status = AiRoutingPolicyStatus.ACTIVE;
    if (enabledOnly) where.enabled = true;

    const orderBy = [{ priority: 'asc' as const }, { policyVersion: 'desc' as const }];
    // `this.db` is the EXTENDED delegate (tenant-scope + soft-delete
    // extensions applied); `tx` is the caller's transaction/base client for the
    // super-admin cross-tenant lane. Both expose the same `findMany`.
    const delegate = tx ? (tx as Record<string, any>).aiRoutingPolicy : this.db;
    const rows = await delegate.findMany({ where, orderBy });
    const mapper = AiRoutingPolicyEntityMapper.getInstance();
    return (rows as AiRoutingPolicy[]).map((row) => mapper.toDomainEntity(row));
  }

  /**
   * TASK-844 — the UNSET half of the default election.
   *
   * Clears `isDefault` on every live row of `(tenantId, taskKey)` except
   * `exceptId`, and returns how many rows it cleared. It exists as a
   * `updateMany` rather than a read-then-write loop because it must be ONE
   * statement inside the caller's transaction: the partial unique index
   * `AiRoutingPolicy_tenant_task_default_unique` is checked at statement end, so
   * unsetting the incumbent and setting the successor in the same transaction is
   * what makes the election atomic instead of a race that the caller has to
   * retry.
   *
   * ⚠ `tx` is REQUIRED. Running the unset outside a transaction would leave a
   * selection with NO default if the subsequent set failed — for a
   * fail-closed selection plane that is an outage, not a degraded state.
   *
   * `_version` is bumped on every touched row so a concurrent OCC writer that
   * held a stale token is still rejected.
   */
  async clearDefaultFor(
    tenantId: string,
    taskKey: string,
    exceptId: string | null,
    tx: Prisma.TransactionClient | any,
    updatedBy?: string,
  ): Promise<number> {
    const where: Record<string, unknown> = {
      tenantId,
      taskKey,
      isDefault: true,
      resourceStatus: { not: ResourceStatusType.DELETED },
    };
    if (exceptId) where.id = { not: exceptId };

    const result = await (tx as Record<string, any>).aiRoutingPolicy.updateMany({
      where,
      data: {
        isDefault: false,
        version: { increment: 1 },
        ...(updatedBy ? { updatedBy } : {}),
      },
    });
    return result.count as number;
  }
}
