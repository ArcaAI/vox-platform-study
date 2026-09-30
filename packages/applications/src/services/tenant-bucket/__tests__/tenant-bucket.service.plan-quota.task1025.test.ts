/**
 * TASK-1025 G3 (owner decision OD-3) — the plan storage quota covers BOTH
 * system buckets, so `applyPlanStorageQuota` stamps the tenant-wide ceiling on
 * the attachments AND the recordings row (it used to stamp only recordings),
 * and it RE-DERIVES the stamp from the plan on every call: a stamp that no
 * longer matches the plan (an upgrade/downgrade) is rewritten, which the old
 * "only when unset" rule silently never did.
 *
 * Enforcement does not read this stamp — `TenantBucketStorageGate` resolves the
 * quota from the entitlements layers. The stamp is the per-bucket display of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantBucketService } from '../tenant-bucket.service';

vi.mock('../../entitlements/entitlements.constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../entitlements/entitlements.constants')>();
  return {
    ...actual,
    PLAN_ENTITLEMENT_DEFAULTS: {
      ...actual.PLAN_ENTITLEMENT_DEFAULTS,
      UNLIMITED_TEST_TIER: { ...actual.PLAN_ENTITLEMENT_DEFAULTS.STARTER, storageQuotaBytes: null },
    },
  };
});

const GIB = 1024 ** 3;
const repo = { findSystemBuckets: vi.fn(), update: vi.fn() };
const bucket = (slug: string, purpose: string, quotaBytes: bigint | null) => ({
  id: `bucket-${slug}`,
  tenantId: 'tenant-1',
  slug,
  purpose,
  quotaBytes,
});

describe('TenantBucketService.applyPlanStorageQuota — TASK-1025 G3 both buckets', () => {
  let service: TenantBucketService;

  beforeEach(() => {
    vi.clearAllMocks();
    repo.update.mockImplementation(async (_id: string, entity: unknown) => entity);
    service = new TenantBucketService(repo as never, {} as never, {} as never, {} as never, { emit: vi.fn() } as never, { get: vi.fn() } as never);
  });

  it('stamps the STARTER quota (5 GiB) on BOTH the attachments and the recordings bucket', async () => {
    repo.findSystemBuckets.mockResolvedValue([bucket('attachments', 'ATTACHMENTS', null), bucket('recordings', 'AUDIO', null)]);

    await service.applyPlanStorageQuota('tenant-1', 'STARTER' as never);

    expect(repo.update).toHaveBeenCalledTimes(2);
    expect(repo.update.mock.calls.map(([id, entity]) => [id, (entity as { quotaBytes: bigint }).quotaBytes])).toEqual([
      ['bucket-attachments', BigInt(5 * GIB)],
      ['bucket-recordings', BigInt(5 * GIB)],
    ]);
  });

  it('re-derives a stale stamp after a plan change', async () => {
    repo.findSystemBuckets.mockResolvedValue([bucket('attachments', 'ATTACHMENTS', BigInt(1024)), bucket('recordings', 'AUDIO', BigInt(1024))]);

    await service.applyPlanStorageQuota('tenant-1', 'STARTER' as never);

    expect(repo.update).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — writes nothing when both stamps already match the plan', async () => {
    repo.findSystemBuckets.mockResolvedValue([bucket('attachments', 'ATTACHMENTS', BigInt(5 * GIB)), bucket('recordings', 'AUDIO', BigInt(5 * GIB))]);

    await service.applyPlanStorageQuota('tenant-1', 'STARTER' as never);

    expect(repo.update).not.toHaveBeenCalled();
  });

  it('clears the stamps when the plan has no storage quota (unlimited)', async () => {
    repo.findSystemBuckets.mockResolvedValue([bucket('attachments', 'ATTACHMENTS', BigInt(5 * GIB)), bucket('recordings', 'AUDIO', null)]);

    await service.applyPlanStorageQuota('tenant-1', 'UNLIMITED_TEST_TIER' as never);

    expect(repo.update).toHaveBeenCalledTimes(1);
    expect((repo.update.mock.calls[0]![1] as { quotaBytes: bigint | null }).quotaBytes).toBeNull();
  });
});
