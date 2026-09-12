/**
 * TASK-959 T6 — the consultation summary path passes the RESOLVED device.
 *
 * After lane SWAP a SELF_HOSTED generation whose builder was handed no `device`
 * records NO compute row at all (the appender never guesses: an invented
 * GPU-hour is an invoice nobody can defend). This service is one of the eight
 * callers that passed none, so every platform LM Studio summary was billed for
 * its tokens and nothing else.
 *
 * What is pinned here is the whole chain, not the builder: the device is
 * resolved from the provider TEXT actually SERVED with, the generation and the
 * guardrail call resolve their own (a tenant may screen on one engine and
 * generate on another), a resolver that throws costs a compute row and never
 * the batch, and a BYOK call's platform CPU leg is recorded as its own
 * `INTERNAL` batch.
 */
import { AiCostBasis, AiUsageUnit } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SummaryService } from '../summary.service';

const TX = { __brand: 'tx' } as unknown as never;

/** A `usage_detail` block from a SELF-HOSTED engine that reported its wall clock. */
function selfHostedUsageDetail(overrides: Record<string, unknown> = {}) {
  return {
    task_id: 'text-task-1',
    request_id: 'corr-1',
    provider: 'lm-studio',
    model: 'qwen3-32b',
    endpoint_kind: 'openai.chat',
    interrupted: false,
    byok: false,
    occurred_at: '2026-09-12T10:00:00.000Z',
    prompt_tokens: 100,
    completion_tokens: 20,
    total_ms: 2500,
    raw: { prompt_tokens: 100, completion_tokens: 20 },
    ...overrides,
  };
}

function makeService(
  overrides: {
    computeDevice?: unknown;
    usageDetail?: Record<string, unknown>;
    guardrailUsage?: Record<string, unknown> | null;
  } = {},
) {
  const contextItemRepository = {
    findById: vi.fn(),
    findCaseNotes: vi.fn().mockResolvedValue([{ id: 'note-1', content: 'case note text' }]),
    findTranscripts: vi.fn().mockResolvedValue([{ id: 't-1', content: 'transcript text' }]),
    findLatestPreSummary: vi.fn().mockResolvedValue(null),
    findLatestPreSummaryWithDecryptedContent: vi.fn().mockResolvedValue({ entity: null, plaintext: null }),
    create: vi.fn().mockResolvedValue({ id: 'ctx-new', content: 'S', createdAt: new Date(), updatedAt: new Date() }),
    encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const consultationRepository = {
    findById: vi.fn().mockResolvedValue({ id: 'c-1', tenantId: 'tenant-1', doctorId: 'doc-1', departmentId: 'dept-1' }),
  };
  const summaryMetaRepository = {
    create: vi.fn().mockResolvedValue({ id: 'meta-1' }),
    encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const httpService = {
    axiosRef: {
      post: vi.fn().mockResolvedValue({
        data: {
          content: 'the summary',
          provider: 'lm-studio',
          model: 'qwen3-32b',
          usage: { prompt_tokens: 100, completion_tokens: 20 },
          usage_detail: overrides.usageDetail ?? selfHostedUsageDetail(),
          guardrail_usage:
            overrides.guardrailUsage === undefined
              ? {
                  task_id: 'guard-1',
                  provider: 'ollama',
                  model: 'granite-guardian',
                  endpoint_kind: 'openai.chat',
                  interrupted: false,
                  byok: false,
                  occurred_at: '2026-09-12T09:59:59.000Z',
                  prompt_tokens: 300,
                  completion_tokens: 4,
                  total_ms: 400,
                  raw: { prompt_tokens: 300, completion_tokens: 4 },
                }
              : overrides.guardrailUsage,
        },
      }),
    },
  };
  const clsService = {
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : key === 'user' ? { id: 'user-1' } : null)),
    set: vi.fn(),
    run: vi.fn((cb: () => unknown) => cb()),
  };
  const promptAssemblyService = {
    assemble: vi.fn().mockResolvedValue({
      userPrompt: 'u',
      systemPrompt: 's',
      hyperparameters: {},
      responseFormat: null,
      resolvedFrom: 'default',
      promptId: 'p-1',
    }),
  };
  const usageLedger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
  const unitOfWork = { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX)) };
  // `cuda` for the generation engine, `cpu` for the guard's — so a row that
  // took the wrong provider is visible as the wrong UNIT, not just a wrong label.
  const computeDevice =
    overrides.computeDevice === undefined
      ? { resolve: vi.fn(async (_tenantId: string, provider: string) => (provider === 'lm-studio' ? 'cuda' : 'cpu')) }
      : overrides.computeDevice;

  const service = new SummaryService(
    contextItemRepository as never,
    consultationRepository as never,
    summaryMetaRepository as never,
    { create: vi.fn() } as never,
    httpService as never,
    { get: vi.fn(() => 'http://text') } as never,
    { emit: vi.fn() } as never,
    clsService as never,
    { create: vi.fn() } as never,
    promptAssemblyService as never,
    { getSecretOptional: vi.fn().mockResolvedValue('') } as never, // secretsService
    undefined, // userProfileRepository
    undefined, // harnessAuditService
    undefined, // harnessGatewayService
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'qwen3-32b' }) } as never,
    undefined, // configResolver
    undefined, // entitlements
    undefined, // trajectoryService
    undefined, // routingPolicies
    undefined, // transcriptSegmentRepository
    usageLedger as never,
    unitOfWork as never,
    undefined, // billing
    undefined, // aiModelRepository
    undefined, // noteGenerationService
    undefined, // phiRedactor
    undefined, // gateEditMiningQueue
    undefined, // textRequestEnrichment
    undefined, // documentTemplateService
    undefined, // visitTypes
    undefined, // dnaReportRepository
    computeDevice as never,
  );

  return { service, summaryMetaRepository, usageLedger, computeDevice: computeDevice as { resolve: ReturnType<typeof vi.fn> } };
}

type Recorded = { common: { operation: string; costBasis?: string }; units: { unit: AiUsageUnit; quantity: unknown; attributesJson?: Record<string, unknown> | null }[] };

const recorded = (ledger: { recordUsage: ReturnType<typeof vi.fn> }, operation: string, costBasis?: string): Recorded[] =>
  ledger.recordUsage.mock.calls
    .map((call) => call[0] as Recorded)
    .filter((input) => input.common.operation === operation && (costBasis === undefined || input.common.costBasis === costBasis));

describe('SummaryService — the resolved compute device reaches the ledger (TASK-959 T6)', () => {
  let harness: ReturnType<typeof makeService>;

  beforeEach(() => {
    harness = makeService();
  });

  it('records a GPU_SECOND row carrying the device the resolver answered for the SERVING provider', async () => {
    await harness.service.generateSummary('c-1', {} as never);

    expect(harness.computeDevice.resolve).toHaveBeenCalledWith('tenant-1', 'lm-studio');
    const [generation] = recorded(harness.usageLedger, 'generate');
    const compute = generation.units.find((unit) => unit.unit === AiUsageUnit.GPU_SECOND);
    expect(compute).toEqual({ unit: AiUsageUnit.GPU_SECOND, quantity: '2.500', attributesJson: { device: 'cuda' } });
  });

  it('resolves the guardrail call against ITS OWN provider, not the generation`s', async () => {
    await harness.service.generateSummary('c-1', {} as never);

    expect(harness.computeDevice.resolve).toHaveBeenCalledWith('tenant-1', 'ollama');
    const [guardrail] = recorded(harness.usageLedger, 'guardrail.validate');
    expect(guardrail.units.find((unit) => unit.unit === AiUsageUnit.CPU_SECOND)).toEqual({
      unit: AiUsageUnit.CPU_SECOND,
      quantity: '0.400',
      attributesJson: { device: 'cpu' },
    });
  });

  it('keeps the token rows and drops only the compute row when the resolver throws', async () => {
    const failing = makeService({ computeDevice: { resolve: vi.fn().mockRejectedValue(new Error('settings backend down')) } });

    await expect(failing.service.generateSummary('c-1', {} as never)).resolves.toBeDefined();

    const [generation] = recorded(failing.usageLedger, 'generate');
    expect(generation.units.map((unit) => unit.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
  });

  it('records the platform CPU leg of a BYOK generation as its own INTERNAL batch, in the same transaction', async () => {
    const byok = makeService({
      usageDetail: selfHostedUsageDetail({ provider: 'openai', byok: true }),
      guardrailUsage: null,
    });

    await byok.service.generateSummary('c-1', {} as never);

    const [tokens] = recorded(byok.usageLedger, 'generate', AiCostBasis.BYOK_NOTIONAL);
    expect(tokens.units.map((unit) => unit.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);

    const [platform] = recorded(byok.usageLedger, 'generate', AiCostBasis.INTERNAL);
    expect(platform.units).toEqual([{ unit: AiUsageUnit.CPU_SECOND, quantity: '2.500', attributesJson: { device: 'cpu' } }]);
    const platformCall = byok.usageLedger.recordUsage.mock.calls.find((call) => (call[0] as Recorded).common.costBasis === AiCostBasis.INTERNAL);
    expect(platformCall![1]).toBe(TX);
  });
});
