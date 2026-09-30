/**
 * TASK-1025 G3 (owner decision OD-3) — the plan storage quota is ONE
 * tenant-wide ceiling, stamped on BOTH of a tenant's system buckets. A plain
 * SUM over bucket rows would therefore double every tenant's quota in the
 * platform consumption roll-up. The configured quota is the per-tenant MAX,
 * summed across tenants for the platform-wide figure.
 */
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { TenantBucketRepository } from '../generated/core/TenantBucketRepository';

function makeRepo(groups: Array<{ tenantId: string; _max: { quotaBytes: bigint | null } }>) {
  const delegate = { groupBy: vi.fn().mockResolvedValue(groups), aggregate: vi.fn() };
  const uow = { getDatabaseService: () => ({ tenantBucket: delegate }) };
  return { repo: new TenantBucketRepository(uow as never), delegate };
}

const GIB = 1024n ** 3n;

describe('TenantBucketRepository.sumConfiguredQuotaBytes — TASK-1025 per-tenant MAX', () => {
  it('counts a tenant whose two system buckets both carry the 5 GiB plan quota ONCE', async () => {
    const { repo, delegate } = makeRepo([{ tenantId: 't1', _max: { quotaBytes: 5n * GIB } }]);

    await expect(repo.sumConfiguredQuotaBytes('t1')).resolves.toBe(5n * GIB);
    expect(delegate.groupBy).toHaveBeenCalledWith({
      by: ['tenantId'],
      _max: { quotaBytes: true },
      where: { tenantId: 't1', quotaBytes: { not: null } },
    });
  });

  it('sums the per-tenant ceilings platform-wide', async () => {
    const { repo, delegate } = makeRepo([
      { tenantId: 't1', _max: { quotaBytes: 5n * GIB } },
      { tenantId: 't2', _max: { quotaBytes: 100n * GIB } },
    ]);

    await expect(repo.sumConfiguredQuotaBytes(null)).resolves.toBe(105n * GIB);
    expect(delegate.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { quotaBytes: { not: null } } }));
  });

  it('keeps "no quota configured" as null, not 0', async () => {
    const { repo } = makeRepo([]);

    await expect(repo.sumConfiguredQuotaBytes(null)).resolves.toBeNull();
  });
});
