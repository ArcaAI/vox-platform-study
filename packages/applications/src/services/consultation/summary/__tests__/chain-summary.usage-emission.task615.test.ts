/**
 * The comprehensive-summary path meters too.
 *
 * A chain summary spans several consultations and is one of the most expensive
 * generations the platform runs, so leaving it unmetered would understate cost
 * exactly where it is highest.
 */
import { AiUsageUnit } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChainSummaryService } from '../chain-summary.service';

const TX = { __brand: 'tx' } as unknown as never;

const USAGE_DETAIL = {
  task_id: 'chain-task-1',
  request_id: 'corr-1',
  provider: 'lm-studio',
  model: 'medgemma',
  endpoint_kind: 'lmstudio.chat',
  interrupted: false,
  byok: false,
  occurred_at: '2026-08-06T10:00:00.000Z',
  prompt_tokens: 4000,
  completion_tokens: 600,
  total_tokens: 4600,
  raw: { prompt_tokens: 4000, completion_tokens: 600 },
};

function makeService() {
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
        data: { content: 'chained summary', provider: 'lm-studio', model: 'medgemma', usage_detail: USAGE_DETAIL },
      }),
    },
  };
  const usageLedger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
  const unitOfWork = { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX)) };

  const service = new ChainSummaryService(
    contextItemRepository as never,
    consultationRepository as never,
    summaryMetaRepository as never,
    { findByContextItem: vi.fn().mockResolvedValue([]) } as never,
    httpService as never,
    { get: vi.fn(() => 'http://smr') } as never,
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
    // `.env.test` sets SECRETS_PROVIDER=vault, under which the PHI guard is
    // fail-closed and refuses to persist without a secrets service.
    { getSecretOptional: vi.fn().mockResolvedValue('') } as never,
    { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'medgemma' }) } as never,
    undefined, // configResolver
    usageLedger as never,
    unitOfWork as never,
  );

  return { service, usageLedger, summaryMetaRepository };
}

describe('ChainSummaryService — ledger emission', () => {
  let harness: ReturnType<typeof makeService>;

  beforeEach(() => {
    harness = makeService();
  });

  it('emits generate rows in the same transaction as the SummaryMeta write', async () => {
    await harness.service.generateComprehensiveSummary('c-1', {} as never);

    expect(harness.summaryMetaRepository.create).toHaveBeenCalledWith(expect.anything(), TX);

    const [input, tx] = harness.usageLedger.recordUsage.mock.calls[0];
    expect(tx).toBe(TX);
    expect(input.common.operation).toBe('generate');
    expect(input.common.idempotencyKey).toBe('llm:chain-task-1');
    expect(input.common.consultationId).toBe('c-1');
    expect(input.units).toEqual([
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 4000 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 600 },
    ]);
  });
});
