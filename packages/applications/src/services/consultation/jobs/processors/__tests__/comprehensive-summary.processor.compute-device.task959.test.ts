/**
 * TASK-959 T6 — the async comprehensive-summary job passes the RESOLVED device.
 *
 * A queue job has no request context, so the device is resolved against the JOB's tenant and
 * the provider on TEXT's own usage block. After lane SWAP a SELF_HOSTED call with no `device`
 * records no compute row at all, and this is the longest generation the platform runs.
 */
import { AiCostBasis, AiUsageUnit } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ComprehensiveSummaryProcessor } from '../comprehensive-summary.processor';

const TENANT = 'tenant-1';
const TX = { __brand: 'tx' } as unknown as never;

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ContextItemFactory: {
      CreateRawSummary: vi.fn((tenantId, consultationId, content, dnaStyleId, createdBy) => ({
        id: 'ctx-1',
        tenantId,
        consultationId,
        content,
        dnaWritingStyleId: dnaStyleId,
        createdBy,
      })),
    },
    SummaryMetaFactory: { CreateSummaryMeta: vi.fn((props) => ({ id: 'meta-1', ...props })) },
  };
});

const consultation = { id: 'consult-1', tenantId: TENANT, departmentId: null, parentConsultationId: null, doctorId: 'doctor-1' };

function usageDetail(overrides: Record<string, unknown> = {}) {
  return {
    task_id: 'job-task-1',
    provider: 'lm-studio',
    model: 'medgemma',
    endpoint_kind: 'lmstudio.chat',
    interrupted: false,
    byok: false,
    occurred_at: '2026-09-12T10:00:00.000Z',
    prompt_tokens: 4000,
    completion_tokens: 600,
    total_ms: 30_000,
    raw: { prompt_tokens: 4000, completion_tokens: 600 },
    ...overrides,
  };
}

const GUARDRAIL_USAGE = {
  task_id: 'job-guard-1',
  provider: 'ollama',
  model: 'granite-guardian',
  endpoint_kind: 'openai.chat',
  interrupted: false,
  byok: false,
  occurred_at: '2026-09-12T09:59:59.000Z',
  prompt_tokens: 300,
  completion_tokens: 4,
  total_ms: 600,
  raw: { prompt_tokens: 300, completion_tokens: 4 },
};

function buildProcessor(overrides: { computeDevice?: unknown; usageDetail?: Record<string, unknown> } = {}) {
  const jobService = {
    notifyProgress: vi.fn().mockResolvedValue(undefined),
    notifyComplete: vi.fn().mockResolvedValue(undefined),
    notifyFailed: vi.fn().mockResolvedValue(undefined),
  };
  const chainSummaryService = {
    resolveLinkedConsultations: vi.fn().mockResolvedValue([consultation]),
    gatherSections: vi.fn().mockResolvedValue([{ consultationId: 'consult-1', type: 'RAW_SUMMARY', content: 'Findings.' }]),
    gatherNamedEntities: vi.fn().mockResolvedValue({}),
  };
  const contextItemRepository = {
    create: vi.fn().mockResolvedValue({ id: 'ctx-1', content: 'Result.' }),
    encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const summaryMetaRepository = {
    create: vi.fn().mockResolvedValue({ id: 'meta-1' }),
    encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const httpService = {
    axiosRef: {
      post: vi.fn().mockResolvedValue({
        data: { summary: 'Result.', usage_detail: overrides.usageDetail ?? usageDetail(), guardrail_usage: GUARDRAIL_USAGE },
      }),
    },
  };
  const jobMetrics = {
    recordJobStart: vi.fn(() => () => 1),
    recordWaitingDuration: vi.fn(),
    recordJobComplete: vi.fn(),
    recordJobFailed: vi.fn(),
    recordTextCallDuration: vi.fn(),
  };
  const usageLedgerService = { recordUsage: vi.fn().mockResolvedValue(undefined) };
  const unitOfWorkService = { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX)) };
  const computeDevice =
    overrides.computeDevice === undefined
      ? { resolve: vi.fn(async (_tenantId: string, provider: string) => (provider === 'lm-studio' ? 'cuda' : 'cpu')) }
      : overrides.computeDevice;

  const processor = new ComprehensiveSummaryProcessor(
    jobService as never,
    chainSummaryService as never,
    contextItemRepository as never,
    { findById: vi.fn().mockResolvedValue(consultation) } as never,
    summaryMetaRepository as never,
    { create: vi.fn() } as never,
    httpService as never,
    { get: vi.fn((key: string) => (key === 'TEXT_URL' ? 'http://text.test' : undefined)) } as never,
    { resolve: vi.fn() } as never,
    {
      assemble: vi.fn().mockResolvedValue({
        userPrompt: 'assembled',
        systemPrompt: 'system',
        hyperparameters: {},
        responseFormat: null,
        resolvedFrom: 'tenant',
      }),
    } as never,
    jobMetrics as never,
    { run: vi.fn(async (fn: () => Promise<unknown>) => fn()), set: vi.fn(), get: vi.fn() } as never,
    undefined, // secretsService
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'medgemma' }) } as never,
    undefined, // configResolver
    usageLedgerService as never,
    unitOfWorkService as never,
    undefined, // noteGenerationService
    undefined, // textRequestEnrichment
    undefined, // visitTypes
    computeDevice as never,
  );

  return { processor, usageLedgerService, computeDevice: computeDevice as { resolve: ReturnType<typeof vi.fn> } };
}

const job = () =>
  ({
    id: 'bull-1',
    timestamp: Date.now(),
    data: { jobId: 'job-1', consultationId: 'consult-1', tenantId: TENANT, userId: 'user-1', request: { template: 'comprehensive', includeNER: false } },
  }) as never;

type Recorded = { common: { operation: string; costBasis?: string }; units: { unit: AiUsageUnit; quantity: unknown; attributesJson?: Record<string, unknown> | null }[] };

const recorded = (ledger: { recordUsage: ReturnType<typeof vi.fn> }, operation: string, costBasis?: string): Recorded[] =>
  ledger.recordUsage.mock.calls
    .map((call) => call[0] as Recorded)
    .filter((input) => input.common.operation === operation && (costBasis === undefined || input.common.costBasis === costBasis));

beforeEach(() => vi.clearAllMocks());

describe('ComprehensiveSummaryProcessor — the resolved compute device reaches the ledger (TASK-959 T6)', () => {
  it('resolves against the JOB`s tenant and the serving provider, and records a GPU_SECOND row', async () => {
    const harness = buildProcessor();

    await harness.processor.process(job());

    expect(harness.computeDevice.resolve).toHaveBeenCalledWith(TENANT, 'lm-studio');
    const [generation] = recorded(harness.usageLedgerService, 'generate');
    expect(generation.units.find((unit) => unit.unit === AiUsageUnit.GPU_SECOND)).toEqual({
      unit: AiUsageUnit.GPU_SECOND,
      quantity: '30.000',
      attributesJson: { device: 'cuda' },
    });
  });

  it('resolves the guardrail call against ITS OWN provider', async () => {
    const harness = buildProcessor();

    await harness.processor.process(job());

    expect(harness.computeDevice.resolve).toHaveBeenCalledWith(TENANT, 'ollama');
    const [guardrail] = recorded(harness.usageLedgerService, 'guardrail.validate');
    expect(guardrail.units.find((unit) => unit.unit === AiUsageUnit.CPU_SECOND)).toEqual({
      unit: AiUsageUnit.CPU_SECOND,
      quantity: '0.600',
      attributesJson: { device: 'cpu' },
    });
  });

  it('keeps the token rows and drops only the compute row when the resolver throws', async () => {
    const harness = buildProcessor({ computeDevice: { resolve: vi.fn().mockRejectedValue(new Error('settings backend down')) } });

    await harness.processor.process(job());

    const [generation] = recorded(harness.usageLedgerService, 'generate');
    expect(generation.units.map((unit) => unit.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
  });

  it('records the platform CPU leg of a BYOK job generation as its own INTERNAL batch in the same transaction', async () => {
    const harness = buildProcessor({ usageDetail: usageDetail({ provider: 'openai', byok: true }) });

    await harness.processor.process(job());

    const [platform] = recorded(harness.usageLedgerService, 'generate', AiCostBasis.INTERNAL);
    expect(platform.units).toEqual([{ unit: AiUsageUnit.CPU_SECOND, quantity: '30.000', attributesJson: { device: 'cpu' } }]);
    const platformCall = harness.usageLedgerService.recordUsage.mock.calls.find(
      (call) => (call[0] as Recorded).common.operation === 'generate' && (call[0] as Recorded).common.costBasis === AiCostBasis.INTERNAL,
    );
    expect(platformCall![1]).toBe(TX);
  });
});
