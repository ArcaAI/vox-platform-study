import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';
import { AiCapability, AiUsageUnit } from '@arcaai/domains';

import { UsageAnalyticsService } from '../usage-analytics.service';

const TENANT = 'tenant-1';

function rollup(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tenantId: TENANT,
    bucketStart: new Date('2026-08-03T00:00:00.000Z'),
    capability: AiCapability.LLM,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    unit: AiUsageUnit.INPUT_TOKEN,
    quantitySum: '100',
    costMicrosSum: 5000n,
    ...overrides,
  };
}

function makeRepos() {
  return {
    rollupDailyRepository: { findByPeriod: vi.fn().mockResolvedValue([]) },
    rollupHourlyRepository: { findByPeriod: vi.fn().mockResolvedValue([]) },
    aggregateRepository: {
      sumCostPerConsultation: vi.fn().mockResolvedValue([]),
      topTenantsByCost: vi.fn().mockResolvedValue([]),
      sumByokNotionalByCapability: vi.fn().mockResolvedValue([]),
    },
    tenantRepository: { findById: vi.fn().mockResolvedValue({ plan: null }) },
    planEntitlementRepository: { findByPlan: vi.fn().mockResolvedValue(null) },
    tenantEntitlementRepository: { findByTenant: vi.fn().mockResolvedValue(null) },
  };
}

function makeService(repos: ReturnType<typeof makeRepos>, user: { roles?: string[] } | null = { roles: ['TENANT_ADMIN'] }) {
  const cls = { get: vi.fn().mockReturnValue(user) };
  return new UsageAnalyticsService(
    repos.rollupDailyRepository as never,
    repos.rollupHourlyRepository as never,
    repos.aggregateRepository as never,
    repos.tenantRepository as never,
    repos.planEntitlementRepository as never,
    repos.tenantEntitlementRepository as never,
    cls as never,
    // TASK-959 — the two bounded raw-ledger reads (the storage snapshot's
    // per-class split and one run's worker CPU). Empty by default here: these
    // tests are about the rollup-derived figures, and the new ones have their
    // own file (`usage-analytics.task959.test.ts`).
    { baseClient: { aiUsageEvent: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn().mockResolvedValue([]) } } } as never,
  );
}

describe('UsageAnalyticsService.getUsageSummary', () => {
  it('sums multiple daily buckets into one line per (capability, provider, model, unit)', async () => {
    const repos = makeRepos();
    repos.rollupDailyRepository.findByPeriod.mockResolvedValue([
      rollup({ quantitySum: '100', costMicrosSum: 5000n }),
      rollup({ bucketStart: new Date('2026-08-04T00:00:00.000Z'), quantitySum: '50', costMicrosSum: 2500n }),
      rollup({ provider: 'openai', quantitySum: '10', costMicrosSum: 100n }),
    ]);
    repos.aggregateRepository.sumByokNotionalByCapability.mockResolvedValue([{ capability: AiCapability.LLM, costMicros: 999n }]);

    const service = makeService(repos);
    const response = await service.getUsageSummary(TENANT, '2026-08');

    expect(response.lines).toHaveLength(2);
    const anthropic = response.lines.find((l) => l.provider === 'anthropic')!;
    expect(anthropic.quantity).toBe('150.000000');
    expect(anthropic.costMicros).toBe('7500');
    const openai = response.lines.find((l) => l.provider === 'openai')!;
    expect(openai.quantity).toBe('10.000000');
    expect(response.totalCostMicros).toBe('7600');
    expect(response.byokNotionalCostMicrosByCapability).toEqual({ [AiCapability.LLM]: '999' });
  });

  it('returns an empty summary when there is no usage', async () => {
    const repos = makeRepos();
    const service = makeService(repos);
    const response = await service.getUsageSummary(TENANT, '2026-08');
    expect(response.lines).toEqual([]);
    expect(response.totalCostMicros).toBe('0');
  });
});

describe('UsageAnalyticsService.getUsageTimeseries', () => {
  it('rejects a range beyond the daily cap before querying', async () => {
    const repos = makeRepos();
    const service = makeService(repos);
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date(from.getTime() + 200 * 24 * 60 * 60 * 1000);
    await expect(service.getUsageTimeseries(TENANT, { capability: AiCapability.STT, unit: AiUsageUnit.AUDIO_SECOND, granularity: 'day', from, to })).rejects.toThrow();
    expect(repos.rollupDailyRepository.findByPeriod).not.toHaveBeenCalled();
  });

  it('filters to the requested capability/unit and merges provider/model dimensions per bucket', async () => {
    const repos = makeRepos();
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to = new Date('2026-08-03T00:00:00.000Z');
    repos.rollupDailyRepository.findByPeriod.mockResolvedValue([
      rollup({ capability: AiCapability.STT, unit: AiUsageUnit.AUDIO_SECOND, provider: 'whisper_cpp', quantitySum: '10', costMicrosSum: 100n }),
      rollup({ capability: AiCapability.STT, unit: AiUsageUnit.AUDIO_SECOND, provider: 'azure-speech', quantitySum: '5', costMicrosSum: 50n }),
      rollup({ capability: AiCapability.LLM, unit: AiUsageUnit.INPUT_TOKEN }), // different capability — excluded
    ]);

    const service = makeService(repos);
    const response = await service.getUsageTimeseries(TENANT, { capability: AiCapability.STT, unit: AiUsageUnit.AUDIO_SECOND, granularity: 'day', from, to });

    expect(response.points).toHaveLength(1);
    expect(response.points[0].quantity).toBe('15.000000');
    expect(response.points[0].costMicros).toBe('150');
  });

  it('uses the hourly repository for hour granularity', async () => {
    const repos = makeRepos();
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to = new Date('2026-08-01T02:00:00.000Z');
    const service = makeService(repos);
    await service.getUsageTimeseries(TENANT, { capability: AiCapability.LLM, unit: AiUsageUnit.INPUT_TOKEN, granularity: 'hour', from, to });
    expect(repos.rollupHourlyRepository.findByPeriod).toHaveBeenCalledWith(TENANT, from, to);
    expect(repos.rollupDailyRepository.findByPeriod).not.toHaveBeenCalled();
  });
});

describe('UsageAnalyticsService.getCostPerEncounter', () => {
  it('delegates to the aggregate repository and computes the distribution', async () => {
    const repos = makeRepos();
    repos.aggregateRepository.sumCostPerConsultation.mockResolvedValue([
      { consultationId: 'c-1', costMicros: 100n },
      { consultationId: 'c-2', costMicros: 300n },
    ]);
    const service = makeService(repos);
    const response = await service.getCostPerEncounter(TENANT, '2026-08');
    expect(response.count).toBe(2);
    expect(response.totalMicros).toBe('400');
  });
});

describe('UsageAnalyticsService.getTopTenants', () => {
  it('rejects a non-super-admin caller (403)', async () => {
    const repos = makeRepos();
    const service = makeService(repos, { roles: ['TENANT_ADMIN'] });
    await expect(service.getTopTenants('2026-08', { limit: 10 })).rejects.toThrow(ForbiddenException);
    expect(repos.aggregateRepository.topTenantsByCost).not.toHaveBeenCalled();
  });

  it('allows a SUPER_ADMIN caller and runs the cross-tenant aggregate', async () => {
    const repos = makeRepos();
    repos.aggregateRepository.topTenantsByCost.mockResolvedValue([{ tenantId: 't-9', costMicros: 12345n }]);
    const service = makeService(repos, { roles: ['SUPER_ADMIN'] });
    const response = await service.getTopTenants('2026-08', { limit: 5 });
    expect(response.tenants).toEqual([{ tenantId: 't-9', costMicros: '12345' }]);
    expect(repos.aggregateRepository.topTenantsByCost).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), 5, undefined);
  });
});

describe('UsageAnalyticsService.getBudgetBurndown', () => {
  it('a null-plan tenant is unlimited on every capability', async () => {
    const repos = makeRepos();
    repos.tenantRepository.findById.mockResolvedValue({ plan: null });
    const service = makeService(repos);
    const response = await service.getBudgetBurndown(TENANT, '2026-08');
    expect(response.capabilities.every((c) => c.allowance === null && c.projectedToExceed === false)).toBe(true);
  });

  it('a missing tenant surfaces as 404', async () => {
    const repos = makeRepos();
    repos.tenantRepository.findById.mockRejectedValue(new DataNotFoundException('Tenant', TENANT));
    const service = makeService(repos);
    await expect(service.getBudgetBurndown(TENANT, '2026-08')).rejects.toThrow(NotFoundException);
  });
});
