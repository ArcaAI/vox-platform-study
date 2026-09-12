/**
 * TASK-959 T6 — the chain-summary path passes the RESOLVED device.
 *
 * A chain summary spans several consultations and is one of the most expensive
 * generations the platform runs, so an unmetered compute row understates cost
 * exactly where it is highest. After lane SWAP a SELF_HOSTED call with no
 * `device` records no compute row at all; this pins that the device reaches the
 * builder, that it comes from the provider that SERVED, and that a resolver
 * failure costs the compute row and never the batch.
 */
import { AiCostBasis, AiUsageUnit } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';

import { ChainSummaryService } from '../chain-summary.service';

const TX = { __brand: 'tx' } as unknown as never;

function usageDetail(overrides: Record<string, unknown> = {}) {
  return {
    task_id: 'chain-task-1',
    request_id: 'corr-1',
    provider: 'lm-studio',
    model: 'medgemma',
    endpoint_kind: 'lmstudio.chat',
    interrupted: false,
    byok: false,
    occurred_at: '2026-09-12T10:00:00.000Z',
    prompt_tokens: 4000,
    completion_tokens: 600,
    total_ms: 12_000,
    engine_ms: 11_500,
    raw: { prompt_tokens: 4000, completion_tokens: 600 },
    ...overrides,
  };
}

function makeService(overrides: { computeDevice?: unknown; usageDetail?: Record<string, unknown> } = {}) {
  const consultation = { id: 'c-1', tenantId: 'tenant-1', doctorId: 'doc-1', departmentId: 'dept-1', patientId: 'pat-1' };
  const contextItemRepository = {
    findById: vi.fn(),
    findTranscripts: vi.fn().mockResolvedValue([{ id: 't-1', content: 'transcript', consultationId: 'c-1' }]),
    findCaseNotes: vi.fn().mockResolvedValue([]),
    findSummaries: vi.fn().mockResolvedValue([]),
    findPreSummaries: vi.fn().mockResolvedValue([]),
    findSharedContext: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'ctx-new', content: 'S', createdAt: new Date(), updatedAt: new Date() }),
    encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const consultationRepository = {
    findById: vi.fn().mockResolvedValue(consultation),
    findConsultationChain: vi.fn().mockResolvedValue([consultation]),
    findByPatientAndDate: vi.fn().mockResolvedValue([consultation]),
  };
  const summaryMetaRepository = {
    create: vi.fn().mockResolvedValue({ id: 'meta-1' }),
    encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const httpService = {
    axiosRef: {
      post: vi.fn().mockResolvedValue({
        data: { content: 'chained summary', provider: 'lm-studio', model: 'medgemma', usage_detail: overrides.usageDetail ?? usageDetail() },
      }),
    },
  };
  const usageLedger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
  const unitOfWork = { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX)) };
  const computeDevice = overrides.computeDevice === undefined ? { resolve: vi.fn().mockResolvedValue('cuda') } : overrides.computeDevice;

  const service = new ChainSummaryService(
    contextItemRepository as never,
    consultationRepository as never,
    summaryMetaRepository as never,
    { findByContextItem: vi.fn().mockResolvedValue([]) } as never,
    httpService as never,
    { get: vi.fn(() => 'http://text') } as never,
    { emit: vi.fn() } as never,
    {
      get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : key === 'user' ? { id: 'user-1' } : null)),
      set: vi.fn(),
      run: vi.fn((cb: () => unknown) => cb()),
    } as never,
    {
      assemble: vi.fn().mockResolvedValue({
        userPrompt: 'u',
        systemPrompt: 's',
        hyperparameters: {},
        responseFormat: null,
        resolvedFrom: 'default',
        promptId: 'p-1',
      }),
    } as never,
    { getSecretOptional: vi.fn().mockResolvedValue('') } as never,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'medgemma' }) } as never,
    undefined, // configResolver
    usageLedger as never,
    unitOfWork as never,
    undefined, // noteGenerationService
    undefined, // textRequestEnrichment
    undefined, // visitTypes
    computeDevice as never,
  );

  return { service, usageLedger, computeDevice: computeDevice as { resolve: ReturnType<typeof vi.fn> } };
}

type Recorded = { common: { operation: string; costBasis?: string }; units: { unit: AiUsageUnit; quantity: unknown; attributesJson?: Record<string, unknown> | null }[] };

describe('ChainSummaryService — the resolved compute device reaches the ledger (TASK-959 T6)', () => {
  it('records a GPU_SECOND row for a self-hosted chain generation, from the engine`s own ms', async () => {
    const harness = makeService();

    await harness.service.generateComprehensiveSummary('c-1', {} as never);

    expect(harness.computeDevice.resolve).toHaveBeenCalledWith('tenant-1', 'lm-studio');
    const [input] = harness.usageLedger.recordUsage.mock.calls[0] as [Recorded];
    // `engine_ms` outranks `total_ms`: the engine's own decode time is closer to what the tenant
    // actually held the model for.
    expect(input.units.find((unit) => unit.unit === AiUsageUnit.GPU_SECOND)).toEqual({
      unit: AiUsageUnit.GPU_SECOND,
      quantity: '11.500',
      attributesJson: { device: 'cuda' },
    });
  });

  it('keeps the token rows and drops only the compute row when the resolver throws', async () => {
    const harness = makeService({ computeDevice: { resolve: vi.fn().mockRejectedValue(new Error('settings backend down')) } });

    await expect(harness.service.generateComprehensiveSummary('c-1', {} as never)).resolves.toBeDefined();

    const [input] = harness.usageLedger.recordUsage.mock.calls[0] as [Recorded];
    expect(input.units.map((unit) => unit.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
  });

  it('records the platform CPU leg of a BYOK chain generation as its own INTERNAL batch in the same transaction', async () => {
    const harness = makeService({ usageDetail: usageDetail({ provider: 'openai', byok: true }) });

    await harness.service.generateComprehensiveSummary('c-1', {} as never);

    const calls = harness.usageLedger.recordUsage.mock.calls as [Recorded, unknown][];
    expect(calls.map(([input]) => input.common.costBasis)).toEqual([AiCostBasis.BYOK_NOTIONAL, AiCostBasis.INTERNAL]);
    expect(calls[1][0].units).toEqual([{ unit: AiUsageUnit.CPU_SECOND, quantity: '11.500', attributesJson: { device: 'cpu' } }]);
    expect(calls[1][1]).toBe(TX);
  });
});
