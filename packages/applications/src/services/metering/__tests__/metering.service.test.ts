/**
 * MeteringService.
 *
 * Verifies the authoritative behaviour, not the mock plumbing:
 *   - `getCurrentUsage` aggregates the CURRENT UTC month window and rounds
 *     transcription-minutes, and performs NO writes (read path).
 *   - `getCurrentUsage` ALSO sums the six ledger-derived unit meters
 *     from `AiUsageRollupDaily` — each mapped metric reads a fixed
 *     (capability, unit) dimension over the same window, EXCEPT
 *     `guardrailCalls`, which is a distinct-`requestId` COUNT over the raw
 *     `AiUsageEvent` ledger (the rollup carries `operation` now #4,
 *     but a rollup aggregates token QUANTITY, not per-call cardinality, so a
 *     distinct-call count still reads the raw event).
 *   - LLM_TOKENS EXCLUDES the guardrail/harness operations from its sum via the
 *     rollup `operation` dimension — they are metered for COGS but
 *     never billed (D16).
 *   - `reconcileTenant` upserts NINE meter rows for that window (the three
 *     business meters + the six unit meters) with the aggregated
 *     values + `reconciledAt`, and returns the usage.
 *   - `reconcileAllActiveTenants` iterates every tenant and is resilient to a
 *     per-tenant failure (keeps going, counts only successes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsageMeterMetric } from '@arcaai/domains';
import { MeteringService } from '../metering.service';
import { currentMonthWindow } from '../metering-window';

const FIXED_NOW = new Date('2026-03-17T09:41:23.456Z');
const WINDOW = currentMonthWindow(FIXED_NOW);

/** A fake `Prisma.Decimal`-shaped value — real rollup reads return this, not a plain number. */
function decimalLike(value: number) {
  return { toNumber: () => value };
}

function makeBaseClient(overrides: Record<string, unknown> = {}) {
  return {
    consultation: { count: vi.fn().mockResolvedValue(12) },
    // 5 min 30 s of audio (330 000 ms) → rounds to 6 minutes.
    audioRecording: { aggregate: vi.fn().mockResolvedValue({ _sum: { duration: 330_000 } }) },
    summaryMeta: { count: vi.fn().mockResolvedValue(7) },
    // Rollup-backed unit meters. Every metric maps to one
    // `aiUsageRollupDaily.aggregate` call except `guardrailCalls`.
    aiUsageRollupDaily: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantitySum: decimalLike(0) } }) },
    aiUsageEvent: { findMany: vi.fn().mockResolvedValue([]) },
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

const ZERO_UNIT_METERS = { sttSessionSeconds: 0, llmTokens: 0, ttsCharacters: 0, nlpTextUnits: 0, guardrailCalls: 0, embeddingTokens: 0 };

describe('MeteringService.getCurrentUsage', () => {
  let baseClient: ReturnType<typeof makeBaseClient>;
  let service: MeteringService;

  beforeEach(() => {
    baseClient = makeBaseClient();
    service = makeService(baseClient);
  });

  it('aggregates the current month window and rounds transcription minutes', async () => {
    const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);

    expect(usage).toEqual({ consultations: 12, transcriptionMinutes: 6, summaries: 7, ...ZERO_UNIT_METERS });
  });

  it('LLM_TOKENS excludes guardrail/harness operations; single-operation meters stay unfiltered', async () => {
    await service.getCurrentUsage('tenant-1', FIXED_NOW);

    const wheres = baseClient.aiUsageRollupDaily.aggregate.mock.calls.map((call: [{ where: Record<string, unknown> }]) => call[0].where);
    const llmWhere = wheres.find((w) => w.capability === 'LLM')!;
    const sttWhere = wheres.find((w) => w.capability === 'STT')!;

    expect(llmWhere.operation).toEqual({ notIn: ['guardrail.validate', 'harness.step'] });
    // A single-operation capability keeps the original query shape (no operation filter).
    expect(sttWhere.operation).toBeUndefined();
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

  describe('Rollup-backed unit meters', () => {
    it('sums STT_SESSION_SECONDS from the SESSION_SECOND unit under capability STT, over the current month window', async () => {
      baseClient.aiUsageRollupDaily.aggregate.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.capability === 'STT' && (where.unit as { in: string[] }).in.includes('SESSION_SECOND')) {
          return { _sum: { quantitySum: decimalLike(1234.7) } };
        }
        return { _sum: { quantitySum: decimalLike(0) } };
      });

      const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);

      expect(usage.sttSessionSeconds).toBe(1235); // rounded
      expect(baseClient.aiUsageRollupDaily.aggregate).toHaveBeenCalledWith({
        _sum: { quantitySum: true },
        where: {
          tenantId: 'tenant-1',
          capability: 'STT',
          unit: { in: ['SESSION_SECOND'] },
          bucketStart: { gte: WINDOW.periodStart, lt: WINDOW.periodEnd },
        },
      });
    });

    it('sums LLM_TOKENS across all five billable token units under capability LLM', async () => {
      baseClient.aiUsageRollupDaily.aggregate.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.capability === 'LLM') return { _sum: { quantitySum: decimalLike(50_000) } };
        return { _sum: { quantitySum: decimalLike(0) } };
      });

      const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);

      expect(usage.llmTokens).toBe(50_000);
      const llmCall = baseClient.aiUsageRollupDaily.aggregate.mock.calls.find((c) => c[0].where.capability === 'LLM')!;
      expect(llmCall[0].where.unit).toEqual({ in: ['INPUT_TOKEN', 'OUTPUT_TOKEN', 'CACHE_READ_TOKEN', 'CACHE_WRITE_TOKEN', 'REASONING_TOKEN'] });
    });

    it('sums TTS_CHARACTERS from the CHARACTER unit under capability TTS', async () => {
      baseClient.aiUsageRollupDaily.aggregate.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.capability === 'TTS') return { _sum: { quantitySum: decimalLike(9_876) } };
        return { _sum: { quantitySum: decimalLike(0) } };
      });

      const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);
      expect(usage.ttsCharacters).toBe(9_876);
      const ttsCall = baseClient.aiUsageRollupDaily.aggregate.mock.calls.find((c) => c[0].where.capability === 'TTS')!;
      expect(ttsCall[0].where.unit).toEqual({ in: ['CHARACTER'] });
    });

    it('sums NLP_TEXT_UNITS from the TEXT_UNIT unit under capability NLP', async () => {
      baseClient.aiUsageRollupDaily.aggregate.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.capability === 'NLP') return { _sum: { quantitySum: decimalLike(321) } };
        return { _sum: { quantitySum: decimalLike(0) } };
      });

      const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);
      expect(usage.nlpTextUnits).toBe(321);
      const nlpCall = baseClient.aiUsageRollupDaily.aggregate.mock.calls.find((c) => c[0].where.capability === 'NLP')!;
      expect(nlpCall[0].where.unit).toEqual({ in: ['TEXT_UNIT'] });
    });

    it('sums EMBEDDING_TOKENS across the billable token units under capability EMBEDDING', async () => {
      baseClient.aiUsageRollupDaily.aggregate.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.capability === 'EMBEDDING') return { _sum: { quantitySum: decimalLike(4_200) } };
        return { _sum: { quantitySum: decimalLike(0) } };
      });

      const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);
      expect(usage.embeddingTokens).toBe(4_200);
    });

    it('treats an empty rollup sum as zero for every unit meter', async () => {
      const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);
      expect(usage.sttSessionSeconds).toBe(0);
      expect(usage.llmTokens).toBe(0);
      expect(usage.ttsCharacters).toBe(0);
      expect(usage.nlpTextUnits).toBe(0);
      expect(usage.embeddingTokens).toBe(0);
    });

    it('handles a null rollup sum (no rows in the window) as zero', async () => {
      baseClient.aiUsageRollupDaily.aggregate.mockResolvedValue({ _sum: { quantitySum: null } });
      const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);
      expect(usage.llmTokens).toBe(0);
    });

    it('counts GUARDRAIL_CALLS as DISTINCT requestIds on the raw ledger (rollups have no operation dimension)', async () => {
      baseClient.aiUsageEvent.findMany.mockResolvedValue([{ requestId: 'req-1' }, { requestId: 'req-2' }, { requestId: 'req-3' }]);

      const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);

      expect(usage.guardrailCalls).toBe(3);
      expect(baseClient.aiUsageEvent.findMany).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-1',
          capability: 'LLM',
          operation: 'guardrail.validate',
          occurredAt: { gte: WINDOW.periodStart, lt: WINDOW.periodEnd },
        },
        select: { requestId: true },
        distinct: ['requestId'],
      });
    });

    it('never reads the rollup/ledger tables from the OLD three business meters', async () => {
      // Regression guard: the existing 3 meters keep their live-aggregate path
      // untouched — they must never route through the new ledger tables.
      await service.getCurrentUsage('tenant-1', FIXED_NOW);
      const capabilitiesQueried = baseClient.aiUsageRollupDaily.aggregate.mock.calls.map((c) => c[0].where.capability);
      expect(capabilitiesQueried.sort()).toEqual(['EMBEDDING', 'LLM', 'NLP', 'STT', 'TTS']);
    });

    it('respects the UTC calendar-month boundary (a leap-Feb tenant does not leak into March)', async () => {
      const febEnd = new Date('2028-02-29T23:59:59.999Z'); // 2028 is a leap year
      const febWindow = currentMonthWindow(febEnd);

      await service.getCurrentUsage('tenant-1', febEnd);

      expect(baseClient.aiUsageRollupDaily.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ bucketStart: { gte: febWindow.periodStart, lt: febWindow.periodEnd } }) }),
      );
      expect(febWindow.periodEnd.toISOString()).toBe('2028-03-01T00:00:00.000Z');
    });
  });
});

describe('MeteringService.reconcileTenant', () => {
  it('upserts NINE meter rows for the window (3 business + 6 unit meters) and returns the usage', async () => {
    const baseClient = makeBaseClient();
    const service = makeService(baseClient);

    const usage = await service.reconcileTenant('tenant-1', FIXED_NOW);

    expect(usage).toEqual({ consultations: 12, transcriptionMinutes: 6, summaries: 7, ...ZERO_UNIT_METERS });
    expect(baseClient.tenantUsageMeter.upsert).toHaveBeenCalledTimes(9);

    const metrics = baseClient.tenantUsageMeter.upsert.mock.calls.map(
      (call: [{ where: { TenantUsageMeter_tenant_metric_period_unique: { metric: UsageMeterMetric } } }]) =>
        call[0].where.TenantUsageMeter_tenant_metric_period_unique.metric,
    );
    expect(metrics).toEqual(
      expect.arrayContaining([
        UsageMeterMetric.CONSULTATIONS,
        UsageMeterMetric.TRANSCRIPTION_MINUTES,
        UsageMeterMetric.SUMMARIES,
        UsageMeterMetric.STT_SESSION_SECONDS,
        UsageMeterMetric.LLM_TOKENS,
        UsageMeterMetric.TTS_CHARACTERS,
        UsageMeterMetric.NLP_TEXT_UNITS,
        UsageMeterMetric.GUARDRAIL_CALLS,
        UsageMeterMetric.EMBEDDING_TOKENS,
      ]),
    );

    const consultationCall = baseClient.tenantUsageMeter.upsert.mock.calls.find(
      (call: [{ where: { TenantUsageMeter_tenant_metric_period_unique: { metric: UsageMeterMetric } } }]) =>
        call[0].where.TenantUsageMeter_tenant_metric_period_unique.metric === UsageMeterMetric.CONSULTATIONS,
    )![0];
    expect(consultationCall.create).toMatchObject({
      tenantId: 'tenant-1',
      // UsedCount persists as BigInt.
      usedCount: 12n,
      periodStart: WINDOW.periodStart,
      periodEnd: WINDOW.periodEnd,
    });
    expect(consultationCall.update).toMatchObject({ usedCount: 12n, reconciledAt: FIXED_NOW });
  });

  it('upserts a unit meter (LLM_TOKENS) with the summed value', async () => {
    const baseClient = makeBaseClient();
    baseClient.aiUsageRollupDaily.aggregate.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.capability === 'LLM') return { _sum: { quantitySum: decimalLike(7_500) } };
      return { _sum: { quantitySum: decimalLike(0) } };
    });
    const service = makeService(baseClient);

    await service.reconcileTenant('tenant-1', FIXED_NOW);

    const llmMeterCall = baseClient.tenantUsageMeter.upsert.mock.calls.find(
      (call: [{ where: { TenantUsageMeter_tenant_metric_period_unique: { metric: UsageMeterMetric } } }]) =>
        call[0].where.TenantUsageMeter_tenant_metric_period_unique.metric === UsageMeterMetric.LLM_TOKENS,
    )![0];
    expect(llmMeterCall.create).toMatchObject({ tenantId: 'tenant-1', usedCount: 7_500n });
  });
});

describe('MeteringService.reconcileAllActiveTenants', () => {
  it('reconciles every tenant and counts the successes', async () => {
    const baseClient = makeBaseClient();
    const service = makeService(baseClient);

    const result = await service.reconcileAllActiveTenants(FIXED_NOW);

    expect(result).toEqual({ tenants: 2 });
    // 2 tenants × 9 meters.
    expect(baseClient.tenantUsageMeter.upsert).toHaveBeenCalledTimes(18);
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
