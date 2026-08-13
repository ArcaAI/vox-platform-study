/**
 * PlatformMetricsService.getConsumptionRollup.
 *
 * Ledger-derived (/ G16): transcription minutes = SUM(STT
 * AUDIO_SECOND rollups)/60 so the dashboard agrees with getUsageSummary;
 * summaries-24h counts only generatedAt ≥ now−24h (still SummaryMeta — no ledger
 * equivalent), storageUsedBytes = SUM(Media.size), storageQuotaBytes =
 * SUM(quotaBytes) (null until a bucket sets one).
 *
 * The reads now route through domain repositories
 * instead of `databaseService.client`, so the mocks stub the repositories.
 * The Prisma call shapes are pinned by the repository unit tests in
 * `packages/domains/src/repositories/generated/core/__tests__/`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiCapability, AiUsageUnit } from '@arcaai/domains';
import { PlatformMetricsService } from '../platform-metrics.service';

function makeRepos(overrides: {
  sttAudioSeconds?: number | null;
  summaries?: number;
  size?: number | null;
  quota?: bigint | null;
  total?: number;
  today?: number;
}) {
  const { sttAudioSeconds = 120, summaries = 5, size = 1000, quota = null, total = 10, today = 3 } = overrides;
  return {
    rollupDaily: { sumQuantityForCapabilityUnits: vi.fn(async () => sttAudioSeconds ?? 0) },
    summaryMeta: { countGeneratedSince: vi.fn(async () => summaries) },
    media: { sumSizeForTenant: vi.fn(async () => size) },
    tenantBucket: { sumConfiguredQuotaBytes: vi.fn(async () => quota) },
    // total has no createdAt filter; today does → distinguish by the filters arg.
    consultation: {
      count: vi.fn(async ({ filters }: { filters: { createdAt?: unknown } }) => (filters?.createdAt ? today : total)),
    },
  };
}

function makeService(repos: ReturnType<typeof makeRepos>) {
  const prometheus = { isConfigured: () => true, instant: vi.fn(), instantVector: vi.fn(), range: vi.fn() };
  const sockets = { getAggregateCount: vi.fn(async () => 0), publishLocalCount: vi.fn() };
  const cache = { get: vi.fn(async () => null), setex: vi.fn(async () => undefined) };
  return new PlatformMetricsService(
    prometheus as any,
    sockets as any,
    cache as any,
    repos.rollupDaily as any,
    repos.summaryMeta as any,
    repos.media as any,
    repos.tenantBucket as any,
    repos.consultation as any,
  );
}

describe('PlatformMetricsService.getConsumptionRollup (#18)', () => {
  let repos: ReturnType<typeof makeRepos>;

  beforeEach(() => {
    repos = makeRepos({});
  });

  it('computes transcription minutes as SUM(STT AUDIO_SECOND rollups)/60', async () => {
    const res = await makeService(repos).getConsumptionRollup(null);
    expect(res.transcriptionMinutes).toBe(2); // 120 audio-seconds → 2 minutes
  });

  it('COALESCEs a null ledger sum to 0 minutes', async () => {
    const res = await makeService(makeRepos({ sttAudioSeconds: null })).getConsumptionRollup(null);
    expect(res.transcriptionMinutes).toBe(0);
  });

  it('counts summaries and storage bytes; quota null until a bucket sets one', async () => {
    const res = await makeService(repos).getConsumptionRollup(null);
    expect(res.summaries24h).toBe(5);
    expect(res.storageUsedBytes).toBe(1000);
    expect(res.storageQuotaBytes).toBeNull();
  });

  it('returns the bucket quota sum (BigInt→number) when configured', async () => {
    const res = await makeService(makeRepos({ quota: 5000n })).getConsumptionRollup(null);
    expect(res.storageQuotaBytes).toBe(5000);
  });

  it('splits total vs today consultation counts', async () => {
    const res = await makeService(repos).getConsumptionRollup(null);
    expect(res.consultations).toEqual({ total: 10, today: 3 });
  });

  it('scopes the aggregates to a tenant when an id is supplied', async () => {
    await makeService(repos).getConsumptionRollup('tenant-9');
    expect(repos.rollupDaily.sumQuantityForCapabilityUnits).toHaveBeenCalledWith('tenant-9', AiCapability.STT, [AiUsageUnit.AUDIO_SECOND]);
    expect(repos.summaryMeta.countGeneratedSince).toHaveBeenCalledWith(expect.any(Date), 'tenant-9');
    expect(repos.media.sumSizeForTenant).toHaveBeenCalledWith('tenant-9');
    expect(repos.tenantBucket.sumConfiguredQuotaBytes).toHaveBeenCalledWith('tenant-9');
    expect(repos.consultation.count).toHaveBeenCalledWith({ filters: { tenantId: 'tenant-9' } });
    expect(repos.consultation.count).toHaveBeenCalledWith({
      filters: { tenantId: 'tenant-9', createdAt: { gte: expect.any(Date) } },
    });
  });

  it('passes null tenant scoping through to every repository (platform-wide roll-up)', async () => {
    await makeService(repos).getConsumptionRollup(null);
    expect(repos.rollupDaily.sumQuantityForCapabilityUnits).toHaveBeenCalledWith(null, AiCapability.STT, [AiUsageUnit.AUDIO_SECOND]);
    expect(repos.summaryMeta.countGeneratedSince).toHaveBeenCalledWith(expect.any(Date), null);
    expect(repos.media.sumSizeForTenant).toHaveBeenCalledWith(null);
    expect(repos.tenantBucket.sumConfiguredQuotaBytes).toHaveBeenCalledWith(null);
    expect(repos.consultation.count).toHaveBeenCalledWith({ filters: {} });
  });
});
