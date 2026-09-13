/**
 * TASK-957 F-8 — `byOperation` and `byTrigger` on the usage summary.
 *
 * The summary answered "what did each model cost" and nothing else, so two
 * questions a tenant actually asks had no answer on the consumption screens:
 * *what kind of work was this* (a transcription, a synthesis, a workflow step)
 * and *what caused it* (a clinician consulting, or an engineer leaving a prompt
 * test looping). Cost-per-encounter is consultation-keyed, so a standalone
 * workflow run was invisible on this surface entirely.
 *
 * The two are computed DIFFERENTLY, and that asymmetry is the design:
 *
 *   - `operation` IS a rollup dimension (`AiUsageRollupDaily.operation`), so
 *     `byOperation` is a regroup of rollups the method already read — no extra
 *     query, and it carries cost because the rollup carries cost.
 *   - `trigger` is an ATTRIBUTE (`attributesJson.trigger`), deliberately not a
 *     rollup dimension. It is answerable only from the raw ledger, so
 *     `byTrigger` is a bounded set of server-side aggregates — one per value of
 *     a CLOSED vocabulary, which is what makes "bounded" a fact rather than a
 *     hope — and it carries no cost, because summing rated cost outside the
 *     rollups is the thing D13 says not to do.
 *
 * Every pre-existing field must stay byte-identical; a consumption screen
 * reading `lines` must not notice this ticket.
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

/** `groupBy` answers per trigger, keyed by the value the filter asked for. */
function makeService(repos: ReturnType<typeof makeRepos>, byTrigger: Record<string, { unit: string; quantity: string }[]> = {}) {
  const groupBy = vi.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
    const filter = where.attributesJson as { equals?: string } | undefined;
    const rowsForTrigger = byTrigger[String(filter?.equals)] ?? [];
    return Promise.resolve(rowsForTrigger.map((row) => ({ unit: row.unit, _sum: { quantity: row.quantity } })));
  });
  const aiUsageEvent = {
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: null } }),
    groupBy,
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
  return { service, groupBy };
}

describe('getUsageSummary — byOperation (TASK-957 F-8)', () => {
  it('groups the SAME rollups by operation, summing quantity per unit and cost across them', async () => {
    const repos = makeRepos();
    repos.rollupDailyRepository.findByPeriod.mockResolvedValue([
      rollup({ operation: 'generate', unit: AiUsageUnit.INPUT_TOKEN, quantitySum: '100', costMicrosSum: 500n }),
      rollup({ operation: 'generate', unit: AiUsageUnit.OUTPUT_TOKEN, quantitySum: '20', costMicrosSum: 400n }),
      // A second model on the SAME operation — the split `lines` keeps is exactly
      // what this view collapses.
      rollup({ operation: 'generate', model: 'gpt-5', unit: AiUsageUnit.INPUT_TOKEN, quantitySum: '50', costMicrosSum: 100n }),
      rollup({ capability: AiCapability.WORKFLOW, operation: 'workflow.step', unit: AiUsageUnit.CPU_SECOND, quantitySum: '3.5', costMicrosSum: 7n }),
    ]);
    const { service, groupBy } = makeService(repos);

    const summary = await service.getUsageSummary(TENANT, '2026-09');

    expect(summary.byOperation).toEqual([
      { operation: 'generate', quantityByUnit: { INPUT_TOKEN: '150.000000', OUTPUT_TOKEN: '20.000000' }, costMicros: '1000' },
      { operation: 'workflow.step', quantityByUnit: { CPU_SECOND: '3.500000' }, costMicros: '7' },
    ]);
    // Derived from rollups already in hand — not a second read.
    expect(repos.rollupDailyRepository.findByPeriod).toHaveBeenCalledTimes(1);
    expect(groupBy).not.toHaveBeenCalledWith(expect.objectContaining({ by: ['operation'] }));
  });

  it('leaves lines, totalCostMicros and the TASK-959 measures untouched', async () => {
    const repos = makeRepos();
    repos.rollupDailyRepository.findByPeriod.mockResolvedValue([rollup({ costMicrosSum: 42n })]);
    const { service } = makeService(repos);

    const summary = await service.getUsageSummary(TENANT, '2026-09');

    expect(summary.lines).toEqual([
      {
        capability: 'LLM',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        unit: 'INPUT_TOKEN',
        quantity: '100.000000',
        costMicros: '42',
      },
    ]);
    expect(summary.totalCostMicros).toBe('42');
  });

  it('returns an empty breakdown for a period with no usage', async () => {
    const { service } = makeService(makeRepos());

    const summary = await service.getUsageSummary(TENANT, '2026-09');

    expect(summary.byOperation).toEqual([]);
    expect(summary.byTrigger).toEqual([]);
  });
});

describe('getUsageSummary — byTrigger (TASK-957 F-8)', () => {
  it('aggregates the raw ledger per trigger, per unit', async () => {
    const repos = makeRepos();
    const { service } = makeService(repos, {
      CONSULTATION: [
        { unit: 'INPUT_TOKEN', quantity: '900' },
        { unit: 'AUDIO_SECOND', quantity: '120.5' },
      ],
      WORKFLOW_RUN: [{ unit: 'INPUT_TOKEN', quantity: '100' }],
    });

    const summary = await service.getUsageSummary(TENANT, '2026-09');

    expect(summary.byTrigger).toEqual([
      { trigger: 'CONSULTATION', quantityByUnit: { AUDIO_SECOND: '120.500000', INPUT_TOKEN: '900.000000' } },
      { trigger: 'WORKFLOW_RUN', quantityByUnit: { INPUT_TOKEN: '100.000000' } },
    ]);
  });

  it('omits a trigger that produced nothing — an empty bucket is noise, not a zero', async () => {
    const { service } = makeService(makeRepos(), { AGENT_TEST: [{ unit: 'INPUT_TOKEN', quantity: '5' }] });

    const summary = await service.getUsageSummary(TENANT, '2026-09');

    expect(summary.byTrigger.map((line) => line.trigger)).toEqual(['AGENT_TEST']);
  });

  it('scopes every aggregate to the tenant and the period — never an unscoped scan', async () => {
    const { service, groupBy } = makeService(makeRepos());

    await service.getUsageSummary(TENANT, '2026-09');

    // One bounded aggregate per value of the CLOSED trigger vocabulary.
    expect(groupBy).toHaveBeenCalledTimes(5);
    for (const [args] of groupBy.mock.calls) {
      expect(args.by).toEqual(['unit']);
      expect(args.where.tenantId).toBe(TENANT);
      expect(args.where.occurredAt).toEqual({ gte: new Date('2026-09-01T00:00:00.000Z'), lt: new Date('2026-10-01T00:00:00.000Z') });
      expect(args.where.attributesJson).toMatchObject({ path: ['trigger'] });
    }
  });
});
