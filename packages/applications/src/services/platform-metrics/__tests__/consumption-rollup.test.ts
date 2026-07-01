/**
 * TASK-386 unit #2 — PlatformMetricsService.getConsumptionRollup (#18).
 *
 * Postgres-derived (live-testable): transcription minutes = SUM(duration)/60000
 * (COALESCE over nullable durations), summaries-24h counts only generatedAt ≥
 * now−24h, storageUsedBytes = SUM(Media.size), storageQuotaBytes = SUM(quotaBytes)
 * (null until a bucket sets one).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlatformMetricsService } from '../platform-metrics.service';

function makeClient(overrides: {
  duration?: number | null;
  summaries?: number;
  size?: number | null;
  quota?: bigint | null;
  total?: number;
  today?: number;
}) {
  const { duration = 120000, summaries = 5, size = 1000, quota = null, total = 10, today = 3 } = overrides;
  return {
    audioRecording: { aggregate: vi.fn(async () => ({ _sum: { duration } })) },
    summaryMeta: { count: vi.fn(async () => summaries) },
    media: { aggregate: vi.fn(async () => ({ _sum: { size } })) },
    tenantBucket: { aggregate: vi.fn(async () => ({ _sum: { quotaBytes: quota } })) },
    // total has no createdAt filter; today does → distinguish by the where arg.
    consultation: { count: vi.fn(async ({ where }: { where: { createdAt?: unknown } }) => (where?.createdAt ? today : total)) },
  };
}

function makeService(client: ReturnType<typeof makeClient>) {
  const prometheus = { isConfigured: () => true, instant: vi.fn(), instantVector: vi.fn(), range: vi.fn() };
  const sockets = { getAggregateCount: vi.fn(async () => 0), publishLocalCount: vi.fn() };
  const cache = { get: vi.fn(async () => null), setex: vi.fn(async () => undefined) };
  return new PlatformMetricsService(prometheus as any, sockets as any, cache as any, { client } as any);
}

describe('PlatformMetricsService.getConsumptionRollup (#18)', () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient({});
  });

  it('computes transcription minutes as SUM(duration)/60000', async () => {
    const res = await makeService(client).getConsumptionRollup(null);
    expect(res.transcriptionMinutes).toBe(2);
  });

  it('COALESCEs a null duration sum to 0 minutes', async () => {
    const res = await makeService(makeClient({ duration: null })).getConsumptionRollup(null);
    expect(res.transcriptionMinutes).toBe(0);
  });

  it('counts summaries and storage bytes; quota null until a bucket sets one', async () => {
    const res = await makeService(client).getConsumptionRollup(null);
    expect(res.summaries24h).toBe(5);
    expect(res.storageUsedBytes).toBe(1000);
    expect(res.storageQuotaBytes).toBeNull();
  });

  it('returns the bucket quota sum (BigInt→number) when configured', async () => {
    const res = await makeService(makeClient({ quota: 5000n })).getConsumptionRollup(null);
    expect(res.storageQuotaBytes).toBe(5000);
  });

  it('splits total vs today consultation counts', async () => {
    const res = await makeService(client).getConsumptionRollup(null);
    expect(res.consultations).toEqual({ total: 10, today: 3 });
  });

  it('scopes the aggregates to a tenant when an id is supplied', async () => {
    await makeService(client).getConsumptionRollup('tenant-9');
    expect(client.media.aggregate).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant-9' } }));
  });
});
