/**
 * TASK-414 — repository aggregate methods backing
 * `PlatformMetricsService.getConsumptionRollup` (TASK-386 #18).
 *
 * The service previously issued these five reads straight off
 * `databaseService.client` (violating the TASK-311 AC-8 layering rule).
 * Each method pins the exact pre-TASK-414 Prisma call shape:
 *
 *   • AudioRecordingRepository.sumDurationForTenant → aggregate _sum.duration
 *   • SummaryMetaRepository.countGeneratedSince     → count generatedAt >= since
 *   • MediaRepository.sumSizeForTenant              → aggregate _sum.size
 *   • TenantBucketRepository.sumConfiguredQuotaBytes→ aggregate _sum.quotaBytes
 *                                                     over rows with a quota set
 *
 * All four scope by tenantId ONLY when one is supplied (`null` = platform-wide
 * roll-up: `where` carries no tenant filter). Raw `_sum` values are returned
 * un-coalesced — the service owns the null→0 / BigInt→number presentation.
 *
 * (The two consultation counts reuse the existing base `Repository.count`,
 * already covered by `packages/domains/src/common/__tests__/repository.test.ts`.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../mappers', () => ({
  AudioRecordingEntityMapper: { getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }) },
  SummaryMetaEntityMapper: { getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }) },
  MediaEntityMapper: { getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }) },
  TenantBucketEntityMapper: { getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }) },
}));

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const makeUow = (delegateByModel: Record<string, any>) => ({ getDatabaseService: () => delegateByModel });

describe('AudioRecordingRepository.sumDurationForTenant (TASK-414)', () => {
  let delegate: any;
  let repo: any;

  beforeEach(async () => {
    delegate = { aggregate: vi.fn() };
    const { AudioRecordingRepository } = await import('../AudioRecordingRepository');
    repo = new AudioRecordingRepository(makeUow({ audioRecording: delegate }) as never);
  });

  it('sums duration scoped to the tenant', async () => {
    delegate.aggregate.mockResolvedValue({ _sum: { duration: 120000 } });

    const result = await repo.sumDurationForTenant('tenant-1');

    expect(delegate.aggregate).toHaveBeenCalledWith({ _sum: { duration: true }, where: { tenantId: 'tenant-1' } });
    expect(result).toBe(120000);
  });

  it('sums across all tenants (empty where) and returns the raw null sum', async () => {
    delegate.aggregate.mockResolvedValue({ _sum: { duration: null } });

    const result = await repo.sumDurationForTenant(null);

    expect(delegate.aggregate).toHaveBeenCalledWith({ _sum: { duration: true }, where: {} });
    expect(result).toBeNull();
  });
});

describe('SummaryMetaRepository.countGeneratedSince (TASK-414)', () => {
  let delegate: any;
  let repo: any;

  const since = new Date('2026-01-01T00:00:00.000Z');

  beforeEach(async () => {
    delegate = { count: vi.fn() };
    const { SummaryMetaRepository } = await import('../SummaryMetaRepository');
    repo = new SummaryMetaRepository(makeUow({ summaryMeta: delegate }) as never);
  });

  it('counts summaries generated at/after `since`, scoped to the tenant', async () => {
    delegate.count.mockResolvedValue(5);

    const result = await repo.countGeneratedSince(since, 'tenant-1');

    expect(delegate.count).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', generatedAt: { gte: since } } });
    expect(result).toBe(5);
  });

  it('counts across all tenants when no tenantId is given', async () => {
    delegate.count.mockResolvedValue(9);

    const result = await repo.countGeneratedSince(since, null);

    expect(delegate.count).toHaveBeenCalledWith({ where: { generatedAt: { gte: since } } });
    expect(result).toBe(9);
  });
});

describe('MediaRepository.sumSizeForTenant (TASK-414)', () => {
  let delegate: any;
  let repo: any;

  beforeEach(async () => {
    delegate = { aggregate: vi.fn() };
    const { MediaRepository } = await import('../MediaRepository');
    repo = new MediaRepository(makeUow({ media: delegate }) as never);
  });

  it('sums media size scoped to the tenant', async () => {
    delegate.aggregate.mockResolvedValue({ _sum: { size: 1000 } });

    const result = await repo.sumSizeForTenant('tenant-1');

    expect(delegate.aggregate).toHaveBeenCalledWith({ _sum: { size: true }, where: { tenantId: 'tenant-1' } });
    expect(result).toBe(1000);
  });

  it('sums across all tenants and returns the raw null sum', async () => {
    delegate.aggregate.mockResolvedValue({ _sum: { size: null } });

    const result = await repo.sumSizeForTenant(null);

    expect(delegate.aggregate).toHaveBeenCalledWith({ _sum: { size: true }, where: {} });
    expect(result).toBeNull();
  });
});

describe('TenantBucketRepository.sumConfiguredQuotaBytes (TASK-414)', () => {
  let delegate: any;
  let repo: any;

  beforeEach(async () => {
    delegate = { aggregate: vi.fn() };
    const { TenantBucketRepository } = await import('../TenantBucketRepository');
    repo = new TenantBucketRepository(makeUow({ tenantBucket: delegate }) as never);
  });

  it('sums quotaBytes over buckets with a quota configured, scoped to the tenant', async () => {
    delegate.aggregate.mockResolvedValue({ _sum: { quotaBytes: 5000n } });

    const result = await repo.sumConfiguredQuotaBytes('tenant-1');

    expect(delegate.aggregate).toHaveBeenCalledWith({
      _sum: { quotaBytes: true },
      where: { tenantId: 'tenant-1', quotaBytes: { not: null } },
    });
    expect(result).toBe(5000n);
  });

  it('returns the raw null sum when no bucket has a quota (platform-wide)', async () => {
    delegate.aggregate.mockResolvedValue({ _sum: { quotaBytes: null } });

    const result = await repo.sumConfiguredQuotaBytes(null);

    expect(delegate.aggregate).toHaveBeenCalledWith({
      _sum: { quotaBytes: true },
      where: { quotaBytes: { not: null } },
    });
    expect(result).toBeNull();
  });
});
