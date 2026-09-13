/**
 * The compute / network / storage figures on the usage-analytics surface
 * (TASK-959 §10.2, lane T4).
 *
 * Four new measures, and the reason each is a separate figure rather than
 * another `lines[]` entry is that each answers a question the per-model
 * breakdown cannot:
 *
 *   - `computeSeconds`   — GPU vs CPU occupancy across the INFERENCE
 *                          capabilities, the two units that are priced an
 *                          order of magnitude apart.
 *   - `workflowCpuSeconds` — the durable worker's own CPU, which is neither STT
 *                          nor LLM and has its own capability for exactly that
 *                          reason.
 *   - `thirdPartyBytes`  — bytes that crossed to a VENDOR, so `SELF_HOSTED`
 *                          rows (LM Studio over the LAN) must not be in it.
 *   - `storage`          — a LEVEL, not a period sum: the latest snapshot day,
 *                          split by class.
 */
import { describe, expect, it, vi } from 'vitest';
import { AiCapability, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';

import { UsageAnalyticsService } from '../usage-analytics.service';

const TENANT = 'tenant-1';
const DAY = new Date('2026-09-12T00:00:00.000Z');

function rollup(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    bucketStart: DAY,
    capability: AiCapability.LLM,
    operation: 'generate',
    provider: 'anthropic',
    deployment: AiDeploymentKind.CLOUD,
    model: 'claude-sonnet-5',
    unit: AiUsageUnit.INPUT_TOKEN,
    quantitySum: '100',
    costMicrosSum: 0n,
    ...overrides,
  };
}

function storageEvent(storageClass: string, quantity: string, occurredAt = new Date('2026-09-12T23:59:59.999Z')) {
  return { occurredAt, quantity, attributesJson: { storageClass } };
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

function makeService(repos: ReturnType<typeof makeRepos>, storageEvents: ReturnType<typeof storageEvent>[] = []) {
  const latest = storageEvents.length > 0 ? storageEvents[0] : null;
  const aiUsageEvent = {
    findFirst: vi.fn().mockResolvedValue(latest ? { occurredAt: latest.occurredAt } : null),
    findMany: vi.fn().mockResolvedValue(storageEvents),
    aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: null } }),
    // TASK-957 F-8 — `byTrigger` aggregates the raw ledger per trigger. No usage
    // in these fixtures, so every bucket is empty and the summary's other
    // figures are untouched.
    groupBy: vi.fn().mockResolvedValue([]),
  };
  const cls = { get: vi.fn().mockReturnValue({ roles: ['TENANT_ADMIN'] }) };
  const service = new UsageAnalyticsService(
    repos.rollupDailyRepository as never,
    repos.rollupHourlyRepository as never,
    repos.aggregateRepository as never,
    repos.tenantRepository as never,
    repos.planEntitlementRepository as never,
    repos.tenantEntitlementRepository as never,
    cls as never,
    { baseClient: { aiUsageEvent } } as never,
  );
  return { service, aiUsageEvent };
}

describe('getUsageSummary — computeSeconds', () => {
  it('splits GPU from CPU seconds across every inference capability', async () => {
    const repos = makeRepos();
    repos.rollupDailyRepository.findByPeriod.mockResolvedValue([
      rollup({ capability: AiCapability.STT, unit: AiUsageUnit.GPU_SECOND, quantitySum: '12.5' }),
      rollup({ capability: AiCapability.LLM, unit: AiUsageUnit.GPU_SECOND, quantitySum: '7.5' }),
      rollup({ capability: AiCapability.NLP, unit: AiUsageUnit.CPU_SECOND, quantitySum: '3' }),
      rollup({ capability: AiCapability.TTS, unit: AiUsageUnit.CPU_SECOND, quantitySum: '1.25' }),
    ]);

    const { service } = makeService(repos);
    const response = await service.getUsageSummary(TENANT, '2026-09');

    expect(response.computeSeconds).toEqual({ gpuSeconds: '20.000000', cpuSeconds: '4.250000' });
  });

  it('keeps the durable worker OUT of computeSeconds and reports it as workflowCpuSeconds', async () => {
    const repos = makeRepos();
    repos.rollupDailyRepository.findByPeriod.mockResolvedValue([
      rollup({ capability: AiCapability.LLM, unit: AiUsageUnit.CPU_SECOND, quantitySum: '2' }),
      rollup({ capability: AiCapability.WORKFLOW, operation: 'workflow.step', provider: 'harness', unit: AiUsageUnit.CPU_SECOND, quantitySum: '9' }),
    ]);

    const { service } = makeService(repos);
    const response = await service.getUsageSummary(TENANT, '2026-09');

    // A run's worker CPU is neither STT nor LLM — that is why it has its own
    // capability, and why adding it to the inference figure would double-count
    // it against a compute allowance.
    expect(response.computeSeconds.cpuSeconds).toBe('2.000000');
    expect(response.workflowCpuSeconds).toBe('9.000000');
  });

  it('reports zeroes, never nulls, when nothing was computed', async () => {
    const { service } = makeService(makeRepos());
    const response = await service.getUsageSummary(TENANT, '2026-09');

    expect(response.computeSeconds).toEqual({ gpuSeconds: '0.000000', cpuSeconds: '0.000000' });
    expect(response.workflowCpuSeconds).toBe('0.000000');
  });
});

describe('getUsageSummary — thirdPartyBytes', () => {
  it('counts CLOUD and BYOK bytes and excludes SELF_HOSTED ones', async () => {
    const repos = makeRepos();
    repos.rollupDailyRepository.findByPeriod.mockResolvedValue([
      rollup({ unit: AiUsageUnit.EGRESS_BYTE, deployment: AiDeploymentKind.CLOUD, quantitySum: '1000' }),
      rollup({ unit: AiUsageUnit.EGRESS_BYTE, deployment: AiDeploymentKind.BYOK, quantitySum: '250' }),
      // LM Studio over the LAN is measured for free but is not third-party egress.
      rollup({ unit: AiUsageUnit.EGRESS_BYTE, deployment: AiDeploymentKind.SELF_HOSTED, provider: 'lm-studio', quantitySum: '99999' }),
      rollup({ unit: AiUsageUnit.INGRESS_BYTE, deployment: AiDeploymentKind.CLOUD, quantitySum: '4000' }),
      rollup({ unit: AiUsageUnit.INGRESS_BYTE, deployment: AiDeploymentKind.SELF_HOSTED, quantitySum: '88888' }),
    ]);

    const { service } = makeService(repos);
    const response = await service.getUsageSummary(TENANT, '2026-09');

    expect(response.thirdPartyBytes).toEqual({ egressBytes: '1250.000000', ingressBytes: '4000.000000' });
  });
});

describe('getUsageSummary — storage', () => {
  it('reports the LATEST snapshot day split by class, not the period sum', async () => {
    const repos = makeRepos();
    const { service, aiUsageEvent } = makeService(repos, [
      storageEvent('media', '2.500000'),
      storageEvent('text', '0.125000'),
      storageEvent('claim-check', '0.004000'),
    ]);

    const response = await service.getUsageSummary(TENANT, '2026-09');

    expect(response.storage).toEqual({
      mediaGb: '2.500000',
      textGb: '0.125000',
      claimCheckGb: '0.004000',
      totalGb: '2.629000',
      asOf: '2026-09-12T23:59:59.999Z',
    });
    // Bounded by construction: find the latest snapshot instant, then read only
    // that instant's rows (at most one per class).
    expect(aiUsageEvent.findFirst).toHaveBeenCalledTimes(1);
    expect(aiUsageEvent.findFirst.mock.calls[0][0].orderBy).toEqual({ occurredAt: 'desc' });
    expect(aiUsageEvent.findMany.mock.calls[0][0].where.occurredAt).toEqual(new Date('2026-09-12T23:59:59.999Z'));
  });

  it('reports a class the snapshot skipped as zero, not as missing', async () => {
    const { service } = makeService(makeRepos(), [storageEvent('text', '1.000000')]);

    const response = await service.getUsageSummary(TENANT, '2026-09');

    expect(response.storage).toEqual({
      mediaGb: '0.000000',
      textGb: '1.000000',
      claimCheckGb: '0.000000',
      totalGb: '1.000000',
      asOf: '2026-09-12T23:59:59.999Z',
    });
  });

  it('is null — not a zeroed object — when the tenant has no snapshot in the period', async () => {
    const { service, aiUsageEvent } = makeService(makeRepos(), []);

    const response = await service.getUsageSummary(TENANT, '2026-09');

    // "Nobody measured" and "the tenant stores nothing" are different answers,
    // and only one of them is a reason to go looking at the job.
    expect(response.storage).toBeNull();
    expect(aiUsageEvent.findMany).not.toHaveBeenCalled();
  });

  it('scopes the snapshot read to the tenant and the STORAGE_GB_DAY unit', async () => {
    const { service, aiUsageEvent } = makeService(makeRepos(), [storageEvent('media', '1.000000')]);

    await service.getUsageSummary(TENANT, '2026-09');
    const where = aiUsageEvent.findFirst.mock.calls[0][0].where;

    expect(where.tenantId).toBe(TENANT);
    expect(where.capability).toBe(AiCapability.STORAGE);
    expect(where.unit).toBe(AiUsageUnit.STORAGE_GB_DAY);
  });

  it('leaves every pre-existing summary field untouched', async () => {
    const repos = makeRepos();
    repos.rollupDailyRepository.findByPeriod.mockResolvedValue([rollup({ quantitySum: '100', costMicrosSum: 5000n })]);

    const { service } = makeService(repos);
    const response = await service.getUsageSummary(TENANT, '2026-09');

    expect(response.lines).toHaveLength(1);
    expect(response.lines[0].quantity).toBe('100.000000');
    expect(response.totalCostMicros).toBe('5000');
    expect(response.period).toBe('2026-09');
  });
});

describe('getUsageTimeseries — the new figures per bucket', () => {
  it('carries compute, workflow CPU, third-party bytes and storage on every point', async () => {
    const repos = makeRepos();
    repos.rollupDailyRepository.findByPeriod.mockResolvedValue([
      // The SELECTED series.
      rollup({ unit: AiUsageUnit.INPUT_TOKEN, quantitySum: '500', costMicrosSum: 700n }),
      // The companion figures — different capabilities and units, same bucket.
      rollup({ capability: AiCapability.STT, unit: AiUsageUnit.GPU_SECOND, quantitySum: '4' }),
      rollup({ capability: AiCapability.WORKFLOW, unit: AiUsageUnit.CPU_SECOND, quantitySum: '6' }),
      rollup({ unit: AiUsageUnit.EGRESS_BYTE, deployment: AiDeploymentKind.CLOUD, quantitySum: '2048' }),
      rollup({
        capability: AiCapability.STORAGE,
        operation: 'storage.snapshot',
        provider: 'minio',
        unit: AiUsageUnit.STORAGE_GB_DAY,
        quantitySum: '1.5',
      }),
      rollup({
        capability: AiCapability.STORAGE,
        operation: 'storage.snapshot',
        provider: 'postgres',
        unit: AiUsageUnit.STORAGE_GB_DAY,
        quantitySum: '0.25',
      }),
    ]);

    const { service } = makeService(repos);
    const response = await service.getUsageTimeseries(TENANT, {
      capability: AiCapability.LLM,
      unit: AiUsageUnit.INPUT_TOKEN,
      granularity: 'day',
      from: DAY,
      to: new Date('2026-09-13T00:00:00.000Z'),
    });

    expect(response.points).toHaveLength(1);
    const point = response.points[0];
    // The selected series is unchanged — the companions never leak into it.
    expect(point.quantity).toBe('500.000000');
    expect(point.costMicros).toBe('700');
    expect(point.computeSeconds).toEqual({ gpuSeconds: '4.000000', cpuSeconds: '0.000000' });
    expect(point.workflowCpuSeconds).toBe('6.000000');
    expect(point.thirdPartyBytes).toEqual({ egressBytes: '2048.000000', ingressBytes: '0.000000' });
    // Both classes of the day summed — the rollup grain cannot split media from
    // claim-check (both are provider `minio`), so the point carries the total.
    expect(point.storageGb).toBe('1.750000');
  });

  it('emits a point for a bucket that has ONLY companion figures, with a zeroed selected series', async () => {
    const repos = makeRepos();
    repos.rollupDailyRepository.findByPeriod.mockResolvedValue([
      rollup({ capability: AiCapability.WORKFLOW, unit: AiUsageUnit.CPU_SECOND, quantitySum: '6' }),
    ]);

    const { service } = makeService(repos);
    const response = await service.getUsageTimeseries(TENANT, {
      capability: AiCapability.LLM,
      unit: AiUsageUnit.INPUT_TOKEN,
      granularity: 'day',
      from: DAY,
      to: new Date('2026-09-13T00:00:00.000Z'),
    });

    expect(response.points).toHaveLength(1);
    expect(response.points[0].quantity).toBe('0.000000');
    expect(response.points[0].workflowCpuSeconds).toBe('6.000000');
  });

  it('reports storageGb as null on a bucket with no snapshot rather than as zero', async () => {
    const repos = makeRepos();
    repos.rollupDailyRepository.findByPeriod.mockResolvedValue([rollup({ unit: AiUsageUnit.INPUT_TOKEN, quantitySum: '10' })]);

    const { service } = makeService(repos);
    const response = await service.getUsageTimeseries(TENANT, {
      capability: AiCapability.LLM,
      unit: AiUsageUnit.INPUT_TOKEN,
      granularity: 'day',
      from: DAY,
      to: new Date('2026-09-13T00:00:00.000Z'),
    });

    expect(response.points[0].storageGb).toBeNull();
  });
});

describe('getWorkflowRunCpuSeconds', () => {
  it('sums CPU_SECOND under capability WORKFLOW for one run id, tenant-scoped', async () => {
    const { service, aiUsageEvent } = makeService(makeRepos());
    aiUsageEvent.aggregate.mockResolvedValue({ _sum: { quantity: { toNumber: () => 12.75 } } });

    const seconds = await service.getWorkflowRunCpuSeconds(TENANT, 'run-7');

    expect(seconds).toBe(12.75);
    const where = aiUsageEvent.aggregate.mock.calls[0][0].where;
    expect(where).toEqual({ tenantId: TENANT, capability: AiCapability.WORKFLOW, unit: AiUsageUnit.CPU_SECOND, requestId: 'run-7' });
  });

  it('answers null — not 0 — when the run has no worker-CPU rows at all', async () => {
    const { service, aiUsageEvent } = makeService(makeRepos());
    aiUsageEvent.aggregate.mockResolvedValue({ _sum: { quantity: null } });

    // A run from before the interceptor shipped, and a run that burned no
    // measurable CPU, are different facts. Zero would assert the second.
    expect(await service.getWorkflowRunCpuSeconds(TENANT, 'run-7')).toBeNull();
  });
});
