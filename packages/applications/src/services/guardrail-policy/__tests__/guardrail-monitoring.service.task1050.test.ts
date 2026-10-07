/**
 * TASK-1050 W2h (README §11.3 E) — platform guardrail monitoring: activity (DB aggregates over
 * `GuardrailEvaluation`), performance (fixed PromQL), health (residency + undetermined rate + freshness), and
 * the content-free drill-down. Cross-tenant, platform admin only (row-independent gate, first).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_PROMQL } from '../../platform-metrics/guardrail-promql';
import { GuardrailMonitoringService } from '../guardrail-monitoring.service';

const NOW = new Date('2026-10-07T12:00:00Z');

function makeService(opts: { roles?: string[]; clsTenantId?: string | null; prometheusDown?: boolean } = {}) {
  const evaluations = {
    aggregateDecisionSeries: vi.fn(async () => [
      { bucketStart: new Date('2026-10-07T10:00:00Z'), direction: 'inbound', decision: 'allow', count: 8 },
      { bucketStart: new Date('2026-10-07T10:00:00Z'), direction: 'inbound', decision: 'warn', count: 1 },
      { bucketStart: new Date('2026-10-07T11:00:00Z'), direction: 'outbound', decision: 'block', count: 1 },
      { bucketStart: new Date('2026-10-07T11:00:00Z'), direction: 'outbound', decision: 'unverified', count: 2 },
    ]),
    aggregateChecks: vi.fn(async () => [{ checkId: 'injection_judge', direction: 'inbound', verdict: 'flag', actionTaken: 'warn', count: 1 }]),
    topCategories: vi.fn(async () => [{ checkId: 'injection_judge', category: 'instruction_override', count: 1 }]),
    aggregateByTenant: vi.fn(async () => [{ tenantId: 't-1', evaluations: 12, warn: 1, block: 1, unverified: 2 }]),
    aggregateByModel: vi.fn(async () => [{ model: 'granite', checkId: 'medical_validation', calls: 12, flags: 0, undetermined: 2, avgLatencyMs: 800 }]),
    countOverrides: vi.fn(async () => 1),
    latestEvaluationAt: vi.fn(async () => new Date('2026-10-07T11:59:30Z')),
    undeterminedShare: vi.fn(async () => 0.1),
    listForDrilldown: vi.fn(async (filter: any) => ({
      items: [{ id: 'e-2', tenantId: 't-1', at: new Date('2026-10-07T11:00:00Z'), direction: 'outbound', decision: 'block', caller: 'text.generate', consultationId: 'c-1', runId: null, nodeId: null, agentSlug: null, exempt: null, policyVersion: 'pv', noticeIds: [], checks: [], hasWithheldContent: true }],
      hasMore: filter.limit === 1,
      last: { at: new Date('2026-10-07T11:00:00Z'), id: 'e-2' },
    })),
  };
  const prometheus = {
    isConfigured: () => true,
    instant: vi.fn(async (q: string) => (opts.prometheusDown ? null : q === GUARDRAIL_PROMQL.judgeCallsPerSecond ? 0.5 : q === GUARDRAIL_PROMQL.evaluationsMissing ? 3 : null)),
    instantVector: vi.fn(async (q: string) => (opts.prometheusDown ? [] : q === GUARDRAIL_PROMQL.windowLatencyP95 ? [{ metric: { task: 'safety' }, value: 1.2 }] : [])),
    range: vi.fn(async () => []),
  };
  const routing = {
    resolveDefault: vi.fn(async (_t: string, taskKey: string) => ({ model: taskKey === 'guardrail.validate' ? { id: 'model-granite', slug: 'granite' } : null, policy: null })),
  };
  const residency = {
    getLifecycleStates: vi.fn(async () => ({ reportedAt: null, services: [{ service: 'lm-studio', models: [{ aiModelId: 'model-granite', slug: 'granite', state: 'loaded' }] }] })),
  };
  const roles = opts.roles ?? ['SUPER_ADMIN'];
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'admin-1', roles } : k === 'tenantId' ? (opts.clsTenantId ?? null) : undefined)) };
  const service = new GuardrailMonitoringService(evaluations as any, routing as any, prometheus as any, { emit: vi.fn() } as any, cls as any, residency as any);
  service.now = () => NOW;
  return { service, evaluations, prometheus, routing };
}

describe('the gate (row-independent, first)', () => {
  it.each([
    ['activity', (s: GuardrailMonitoringService) => s.activity({})],
    ['performance', (s: GuardrailMonitoringService) => s.performance()],
    ['health', (s: GuardrailMonitoringService) => s.health()],
    ['evaluations', (s: GuardrailMonitoringService) => s.evaluations({})],
  ])('%s: a tenant admin is 403 and nothing is read', async (_name, call) => {
    const { service, evaluations, prometheus } = makeService({ roles: ['TENANT_ADMIN'] });
    await expect(call(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(evaluations.aggregateDecisionSeries).not.toHaveBeenCalled();
    expect(evaluations.listForDrilldown).not.toHaveBeenCalled();
    expect(prometheus.instant).not.toHaveBeenCalled();
  });

  it('a super admin with a customer working tenant is 403; SYSTEM / none pass', async () => {
    await expect(makeService({ clsTenantId: 'aaaaaaaa-0000-0000-0000-000000000001' }).service.health()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(makeService({ clsTenantId: SYSTEM_TENANT_ID }).service.health()).resolves.toBeDefined();
  });
});

describe('activity — DB aggregates', () => {
  it('defaults to the last 24 h in 1 h buckets and totals the decisions', async () => {
    const { service, evaluations } = makeService();
    const response = await service.activity({});
    expect(response).toMatchObject({ from: '2026-10-06T12:00:00.000Z', to: '2026-10-07T12:00:00.000Z', bucket: '1h', tenantId: null });
    expect(evaluations.aggregateDecisionSeries).toHaveBeenCalledWith({ from: new Date('2026-10-06T12:00:00Z'), to: NOW, bucketSeconds: 3600 });
    expect(response.totals).toEqual({ evaluations: 12, allow: 8, warn: 1, block: 1, unverified: 2, flagRate: 2 / 12, overrides: 1 });
    expect(response.series[0]).toEqual({ bucketStart: '2026-10-07T10:00:00.000Z', direction: 'inbound', decision: 'allow', count: 8 });
    expect(response.checks).toHaveLength(1);
    expect(response.topCategories[0]).toMatchObject({ category: 'instruction_override' });
    expect(response.perTenant[0]).toMatchObject({ tenantId: 't-1' });
    expect(response.perModel[0]).toMatchObject({ model: 'granite', avgLatencyMs: 800 });
  });

  it('passes the tenant narrowing and the bucket through', async () => {
    const { service, evaluations } = makeService();
    await service.activity({ from: '2026-10-07T00:00:00Z', to: '2026-10-07T06:00:00Z', bucket: '5m', tenantId: 'aaaaaaaa-0000-0000-0000-000000000001' });
    expect(evaluations.aggregateDecisionSeries).toHaveBeenCalledWith(expect.objectContaining({ bucketSeconds: 300, tenantId: 'aaaaaaaa-0000-0000-0000-000000000001' }));
    expect(evaluations.countOverrides).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'aaaaaaaa-0000-0000-0000-000000000001' }));
  });

  it('refuses an inverted window, a window over 31 days, and too many buckets (400)', async () => {
    const { service } = makeService();
    await expect(service.activity({ from: '2026-10-07T00:00:00Z', to: '2026-10-06T00:00:00Z' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.activity({ from: '2026-08-01T00:00:00Z', to: '2026-10-07T00:00:00Z', bucket: '1d' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.activity({ from: '2026-09-07T00:00:00Z', to: '2026-10-07T00:00:00Z', bucket: '5m' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a zero-evaluation window has flagRate 0, not NaN', async () => {
    const { service, evaluations } = makeService();
    evaluations.aggregateDecisionSeries.mockResolvedValueOnce([]);
    expect((await service.activity({})).totals.flagRate).toBe(0);
  });
});

describe('performance — fixed PromQL only', () => {
  it('runs exactly the GUARDRAIL_PROMQL queries and labels each sample', async () => {
    const { service, prometheus } = makeService();
    const response = await service.performance();
    const asked = [...prometheus.instant.mock.calls, ...prometheus.instantVector.mock.calls].map((c) => c[0]).sort();
    expect(asked).toEqual(Object.values(GUARDRAIL_PROMQL).sort());
    expect(response).toMatchObject({ available: true, judgeCallsPerSecond: 0.5, evaluationsMissing: 3, windowLatencyP95: [{ labels: { task: 'safety' }, value: 1.2 }] });
  });

  it('is `available: false` when Prometheus answers nothing, never a 5xx', async () => {
    const response = await makeService({ prometheusDown: true }).service.performance();
    expect(response).toMatchObject({ available: false, judgeCallsPerSecond: null, evaluationsMissing: null, queueDepth: [] });
  });
});

describe('health', () => {
  it('reports residency per guardrail task key, the undetermined rate and the freshness', async () => {
    const response = await makeService().service.health();
    expect(response.models.find((m) => m.taskKey === 'guardrail.validate')).toMatchObject({ modelId: 'model-granite', residency: 'loaded', lane: 'medical_validation' });
    expect(response.models.find((m) => m.taskKey === 'guardrail.judge.injection')).toMatchObject({ modelId: null, residency: 'unselected', lane: 'injection_judge' });
    expect(response).toMatchObject({ undeterminedRate: 0.1, lastEvaluationAt: '2026-10-07T11:59:30.000Z', secondsSinceLastEvaluation: 30 });
  });
});

describe('evaluations — keyset drill-down, no content', () => {
  it('returns an opaque cursor that round-trips into the next query', async () => {
    const { service, evaluations } = makeService();
    const first = await service.evaluations({ limit: 1, decision: 'block' });
    expect(first.items[0]).toMatchObject({ id: 'e-2', at: '2026-10-07T11:00:00.000Z', hasWithheldContent: true });
    expect(first.hasMore).toBe(true);
    expect(typeof first.nextCursor).toBe('string');
    await service.evaluations({ limit: 1, cursor: first.nextCursor as string });
    expect(evaluations.listForDrilldown).toHaveBeenLastCalledWith(expect.objectContaining({ after: { at: new Date('2026-10-07T11:00:00Z'), id: 'e-2' } }));
  });

  it('a forged cursor is 400', async () => {
    await expect(makeService().service.evaluations({ cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('defaults the page size to 50', async () => {
    const { service, evaluations } = makeService();
    await service.evaluations({});
    expect(evaluations.listForDrilldown).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });
});
