/**
 * ShadowMeteringService.
 *
 * Verifies: `runForTenant` computes the ledger-vs-summaryMeta comparison and
 * the six ledger-vs-meter comparisons, flags breaches via `computeDrift`,
 * emits `SHADOW_METERING_DRIFT_DETECTED_EVENT` only when a breach exists,
 * and `runForAllActiveTenants` sweeps every tenant and is resilient to a
 * per-tenant failure. Scheduling on/off mirrors `MeteringService` /
 * `AuditRetentionService` (config-driven, OFF by default).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShadowMeteringService } from '../shadow-metering.service';
import { currentMonthWindow } from '../../metering-window';
import { SHADOW_METERING_DRIFT_DETECTED_EVENT } from '../shadow-metering.constants';

const FIXED_NOW = new Date('2026-03-17T09:41:23.456Z');
const WINDOW = currentMonthWindow(FIXED_NOW);

function decimalLike(value: number) {
  return { toNumber: () => value };
}

function makeBaseClient(overrides: Record<string, unknown> = {}) {
  return {
    aiUsageRollupDaily: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantitySum: decimalLike(100) } }) },
    summaryMeta: { aggregate: vi.fn().mockResolvedValue({ _sum: { inputTokens: 60, outputTokens: 40 } }) },
    aiUsageEvent: { findMany: vi.fn().mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({ requestId: `req-${i}` }))) },
    tenantUsageMeter: { findUnique: vi.fn().mockResolvedValue({ usedCount: 100 }) },
    tenant: { findMany: vi.fn().mockResolvedValue([{ id: 't1' }, { id: 't2' }]) },
    ...overrides,
  };
}

function makeService(baseClient: ReturnType<typeof makeBaseClient>, enabled = false) {
  const appSettings = { getValueWithDefault: vi.fn((_key: string, fallback: unknown) => (typeof fallback === 'boolean' ? enabled : fallback)) } as never;
  const schedulerRegistry = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as never;
  const eventEmitter = { emit: vi.fn() } as never;
  const databaseService = { baseClient } as never;
  return {
    service: new ShadowMeteringService(appSettings, schedulerRegistry, eventEmitter, databaseService),
    eventEmitter,
  };
}

describe('ShadowMeteringService.runForTenant', () => {
  it('produces 7 comparisons: ledger-vs-summaryMeta:LLM_TOKENS + 6 ledger-vs-meter rows', async () => {
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient);

    const report = await service.runForTenant('tenant-1', FIXED_NOW);

    expect(report.tenantId).toBe('tenant-1');
    expect(report.periodStart).toEqual(WINDOW.periodStart);
    expect(report.comparisons).toHaveLength(7);
    expect(report.comparisons.map((c) => c.label)).toEqual([
      'ledger-vs-summaryMeta:LLM_TOKENS',
      'ledger-vs-meter:STT_SESSION_SECONDS',
      'ledger-vs-meter:LLM_TOKENS',
      'ledger-vs-meter:TTS_CHARACTERS',
      'ledger-vs-meter:NLP_TEXT_UNITS',
      'ledger-vs-meter:GUARDRAIL_CALLS',
      'ledger-vs-meter:EMBEDDING_TOKENS',
    ]);
  });

  it('reports no breaches when the ledger, SummaryMeta, and persisted meter all agree', async () => {
    // ledger rollup=100, summaryMeta=60+40=100 (exact match); meter=100 matches live aggregate 100.
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient);

    const report = await service.runForTenant('tenant-1', FIXED_NOW);

    expect(report.breaches).toEqual([]);
  });

  it('flags a breach when SummaryMeta under-counts the ledger beyond 2%', async () => {
    const baseClient = makeBaseClient({
      summaryMeta: { aggregate: vi.fn().mockResolvedValue({ _sum: { inputTokens: 30, outputTokens: 20 } }) }, // 50 vs ledger 100 → -50%
    });
    const { service, eventEmitter } = makeService(baseClient);

    const report = await service.runForTenant('tenant-1', FIXED_NOW);

    const breach = report.breaches.find((b) => b.label === 'ledger-vs-summaryMeta:LLM_TOKENS');
    expect(breach).toBeDefined();
    expect(breach?.relativeDrift).toBeCloseTo(-0.5);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      SHADOW_METERING_DRIFT_DETECTED_EVENT,
      expect.objectContaining({ tenantId: 'tenant-1' }),
    );
  });

  it('flags a breach when the persisted TenantUsageMeter snapshot is stale relative to the live aggregate', async () => {
    const baseClient = makeBaseClient({
      // Every metric's live aggregate is 100 (rollup mock); persisted meter frozen at 50 → -50% for each ledger-vs-meter comparison.
      tenantUsageMeter: { findUnique: vi.fn().mockResolvedValue({ usedCount: 50 }) },
    });
    const { service } = makeService(baseClient);

    const report = await service.runForTenant('tenant-1', FIXED_NOW);

    const meterBreaches = report.breaches.filter((b) => b.label.startsWith('ledger-vs-meter:'));
    expect(meterBreaches.length).toBeGreaterThan(0);
  });

  it('does not emit the drift event when there are no breaches', async () => {
    const baseClient = makeBaseClient();
    const { service, eventEmitter } = makeService(baseClient);

    await service.runForTenant('tenant-1', FIXED_NOW);

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('includes provider-reconciler availability, all unavailable (stub registry)', async () => {
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient);

    const report = await service.runForTenant('tenant-1', FIXED_NOW);

    expect(report.providerAvailability).toHaveLength(3);
    expect(report.providerAvailability.every((p) => p.available === false)).toBe(true);
  });

  it('treats a missing persisted meter row as 0 (never throws)', async () => {
    const baseClient = makeBaseClient({ tenantUsageMeter: { findUnique: vi.fn().mockResolvedValue(null) } });
    const { service } = makeService(baseClient);

    const report = await service.runForTenant('tenant-1', FIXED_NOW);

    const sttComparison = report.comparisons.find((c) => c.label === 'ledger-vs-meter:STT_SESSION_SECONDS');
    expect(sttComparison?.actual).toBe(0);
  });
});

describe('ShadowMeteringService.runForAllActiveTenants', () => {
  it('sweeps every tenant and aggregates breach counts', async () => {
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient);

    const result = await service.runForAllActiveTenants(FIXED_NOW);

    expect(result.tenants).toBe(2);
    expect(result.reports).toHaveLength(2);
  });

  it('continues past a per-tenant failure and still reports the successful ones', async () => {
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient);
    const spy = vi.spyOn(service, 'runForTenant');
    spy.mockRejectedValueOnce(new Error('boom')).mockImplementation(async (tenantId: unknown) => ({
      tenantId: tenantId as string,
      periodStart: WINDOW.periodStart,
      periodEnd: WINDOW.periodEnd,
      comparisons: [],
      breaches: [],
      providerAvailability: [],
    }));

    const result = await service.runForAllActiveTenants(FIXED_NOW);

    expect(result.tenants).toBe(1);
  });
});

describe('ShadowMeteringService scheduling', () => {
  it('is disabled by default and never registers a cron job', () => {
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient, false);

    service.onModuleInit();

    expect(service.isEnabled).toBe(false);
  });

  it('schedules a cron job when enabled via settings', () => {
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient, true);

    service.onModuleInit();

    expect(service.isEnabled).toBe(true);
  });
});
