/**
 * MeteringService.
 *
 * Verifies the authoritative behaviour, not the mock plumbing:
 *   - `getCurrentUsage` aggregates the CURRENT UTC month window and rounds
 *     transcription-minutes, and performs NO writes (read path).
 *   - `reconcileTenant` upserts the three meter rows for that window with the
 *     aggregated values + `reconciledAt`, and returns the usage.
 *   - `reconcileAllActiveTenants` iterates every tenant and is resilient to a
 *     per-tenant failure (keeps going, counts only successes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsageMeterMetric } from '@arcaai/domains';
import { MeteringService } from '../metering.service';
import { currentMonthWindow } from '../metering-window';

const FIXED_NOW = new Date('2026-03-17T09:41:23.456Z');
const WINDOW = currentMonthWindow(FIXED_NOW);

function makeBaseClient(overrides: Record<string, unknown> = {}) {
  return {
    consultation: { count: vi.fn().mockResolvedValue(12) },
    // 5 min 30 s of audio (330 000 ms) → rounds to 6 minutes.
    audioRecording: { aggregate: vi.fn().mockResolvedValue({ _sum: { duration: 330_000 } }) },
    summaryMeta: { count: vi.fn().mockResolvedValue(7) },
    tenant: { findMany: vi.fn().mockResolvedValue([{ id: 't1' }, { id: 't2' }]) },
    tenantUsageMeter: { upsert: vi.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

function makeService(baseClient: ReturnType<typeof makeBaseClient>) {
  const appSettings = {
    getValueWithDefault: vi.fn((_key: string, fallback: unknown) => fallback),
  } as never;
  const schedulerRegistry = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as never;
  const databaseService = { baseClient } as never;
  return new MeteringService(appSettings, schedulerRegistry, databaseService);
}

describe('MeteringService.getCurrentUsage', () => {
  let baseClient: ReturnType<typeof makeBaseClient>;
  let service: MeteringService;

  beforeEach(() => {
    baseClient = makeBaseClient();
    service = makeService(baseClient);
  });

  it('aggregates the current month window and rounds transcription minutes', async () => {
    const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);

    expect(usage).toEqual({ consultations: 12, transcriptionMinutes: 6, summaries: 7 });
  });

  it('scopes every aggregate to (tenantId, current window)', async () => {
    await service.getCurrentUsage('tenant-1', FIXED_NOW);

    expect(baseClient.consultation.count).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', createdAt: { gte: WINDOW.periodStart, lt: WINDOW.periodEnd } },
    });
    expect(baseClient.audioRecording.aggregate).toHaveBeenCalledWith({
      _sum: { duration: true },
      where: { tenantId: 'tenant-1', createdAt: { gte: WINDOW.periodStart, lt: WINDOW.periodEnd } },
    });
    expect(baseClient.summaryMeta.count).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', generatedAt: { gte: WINDOW.periodStart, lt: WINDOW.periodEnd } },
    });
  });

  it('performs no writes on the read path', async () => {
    await service.getCurrentUsage('tenant-1', FIXED_NOW);
    expect(baseClient.tenantUsageMeter.upsert).not.toHaveBeenCalled();
  });

  it('treats an empty audio sum as zero minutes', async () => {
    baseClient = makeBaseClient({ audioRecording: { aggregate: vi.fn().mockResolvedValue({ _sum: { duration: null } }) } });
    service = makeService(baseClient);

    const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);
    expect(usage.transcriptionMinutes).toBe(0);
  });
});

describe('MeteringService.reconcileTenant', () => {
  it('upserts the three meter rows for the window and returns the usage', async () => {
    const baseClient = makeBaseClient();
    const service = makeService(baseClient);

    const usage = await service.reconcileTenant('tenant-1', FIXED_NOW);

    expect(usage).toEqual({ consultations: 12, transcriptionMinutes: 6, summaries: 7 });
    expect(baseClient.tenantUsageMeter.upsert).toHaveBeenCalledTimes(3);

    const metrics = baseClient.tenantUsageMeter.upsert.mock.calls.map(
      (call: [{ where: { TenantUsageMeter_tenant_metric_period_unique: { metric: UsageMeterMetric } } }]) =>
        call[0].where.TenantUsageMeter_tenant_metric_period_unique.metric,
    );
    expect(metrics).toEqual(
      expect.arrayContaining([UsageMeterMetric.CONSULTATIONS, UsageMeterMetric.TRANSCRIPTION_MINUTES, UsageMeterMetric.SUMMARIES]),
    );

    const consultationCall = baseClient.tenantUsageMeter.upsert.mock.calls.find(
      (call: [{ where: { TenantUsageMeter_tenant_metric_period_unique: { metric: UsageMeterMetric } } }]) =>
        call[0].where.TenantUsageMeter_tenant_metric_period_unique.metric === UsageMeterMetric.CONSULTATIONS,
    )![0];
    expect(consultationCall.create).toMatchObject({ tenantId: 'tenant-1', usedCount: 12, periodStart: WINDOW.periodStart, periodEnd: WINDOW.periodEnd });
    expect(consultationCall.update).toMatchObject({ usedCount: 12, reconciledAt: FIXED_NOW });
  });
});

describe('MeteringService.reconcileAllActiveTenants', () => {
  it('reconciles every tenant and counts the successes', async () => {
    const baseClient = makeBaseClient();
    const service = makeService(baseClient);

    const result = await service.reconcileAllActiveTenants(FIXED_NOW);

    expect(result).toEqual({ tenants: 2 });
    // 2 tenants × 3 meters.
    expect(baseClient.tenantUsageMeter.upsert).toHaveBeenCalledTimes(6);
  });

  it('keeps going when one tenant fails and counts only the successes', async () => {
    const baseClient = makeBaseClient({
      consultation: {
        count: vi.fn((args: { where: { tenantId: string } }) =>
          args.where.tenantId === 't1' ? Promise.reject(new Error('boom')) : Promise.resolve(3),
        ),
      },
    });
    const service = makeService(baseClient);

    const result = await service.reconcileAllActiveTenants(FIXED_NOW);

    expect(result).toEqual({ tenants: 1 });
  });
});
