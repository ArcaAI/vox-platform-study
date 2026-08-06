/**
 * TASK-615 WS-D — `SummaryMeta` writes co-emit ledger rows, in one transaction.
 *
 * The rule the contract cares about is not "usage gets recorded" but
 * "usage and the work that produced it commit together". A generation whose
 * `SummaryMeta` rolls back must not leave a billed event behind, and a
 * `SummaryMeta` that commits must not lose its usage to a crash a millisecond
 * later. The only way to get both is the same `tx`, which is what these tests
 * assert on.
 */
import { AiUsageUnit } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SummaryService } from '../summary.service';

const TX = { __brand: 'tx' } as unknown as never;

function makeService(overrides: { usageLedger?: unknown; unitOfWork?: unknown } = {}) {
  const contextItemRepository = {
    findById: vi.fn(),
    findCaseNotes: vi.fn().mockResolvedValue([{ id: 'note-1', content: 'case note text' }]),
    findTranscripts: vi.fn().mockResolvedValue([{ id: 't-1', content: 'transcript text' }]),
    findLatestPreSummary: vi.fn().mockResolvedValue(null),
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
          provider: 'openai',
          model: 'gpt-5',
          usage: { prompt_tokens: 100, completion_tokens: 20 },
          usage_detail: {
            task_id: 'smr-task-1',
            request_id: 'corr-1',
            provider: 'openai',
            model: 'gpt-5',
            endpoint_kind: 'openai.chat',
            interrupted: false,
            byok: false,
            occurred_at: '2026-08-06T10:00:00.000Z',
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            raw: { prompt_tokens: 100, completion_tokens: 20 },
          },
          guardrail_usage: {
            task_id: 'guard-1',
            provider: 'lm-studio',
            model: 'granite-guardian',
            endpoint_kind: 'lmstudio.chat',
            interrupted: false,
            byok: false,
            occurred_at: '2026-08-06T09:59:59.000Z',
            prompt_tokens: 300,
            completion_tokens: 4,
            total_tokens: 304,
            raw: { prompt_tokens: 300, completion_tokens: 4 },
          },
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
  const usageLedger = overrides.usageLedger ?? { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
  const unitOfWork = overrides.unitOfWork ?? { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX)) };

  const service = new SummaryService(
    contextItemRepository as never,
    consultationRepository as never,
    summaryMetaRepository as never,
    { create: vi.fn() } as never,
    httpService as never,
    { get: vi.fn(() => 'http://smr') } as never,
    { emit: vi.fn() } as never,
    clsService as never,
    { create: vi.fn() } as never,
    promptAssemblyService as never,
    // A stub secrets service: `.env.test` sets SECRETS_PROVIDER=vault, under
    // which the PHI-encryption guard is FAIL-CLOSED and refuses to persist
    // without one. Encryption itself is stubbed on the repositories.
    { getSecretOptional: vi.fn().mockResolvedValue('') } as never, // secretsService
    undefined, // userProfileRepository
    undefined, // harnessAuditService
    undefined, // harnessGatewayService
    { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'openai', model: 'gpt-5' }) } as never,
    undefined, // configResolver
    undefined, // entitlements
    undefined, // trajectoryService
    undefined, // aiTaskDefaultService
    undefined, // transcriptSegmentRepository
    usageLedger as never,
    unitOfWork as never,
  );

  return { service, summaryMetaRepository, usageLedger: usageLedger as { recordUsage: ReturnType<typeof vi.fn> }, unitOfWork, httpService };
}

describe('SummaryService — ledger emission on SummaryMeta write', () => {
  let harness: ReturnType<typeof makeService>;

  beforeEach(() => {
    harness = makeService();
  });

  it('emits LLM token rows in the SAME transaction as the SummaryMeta write', async () => {
    await harness.service.generateSummary('c-1', {} as never);

    expect(harness.summaryMetaRepository.create).toHaveBeenCalledWith(expect.anything(), TX);

    const llmCall = harness.usageLedger.recordUsage.mock.calls.find((c) => c[0].common.operation === 'generate');
    expect(llmCall).toBeDefined();
    expect(llmCall![1]).toBe(TX); // the same tx — not a second, independent write
    expect(llmCall![0].common.idempotencyKey).toBe('llm:smr-task-1');
    expect(llmCall![0].common.tenantId).toBe('tenant-1');
    expect(llmCall![0].common.consultationId).toBe('c-1');
    expect(llmCall![0].common.doctorId).toBe('doc-1');
    expect(llmCall![0].common.departmentId).toBe('dept-1');
    expect(llmCall![0].units).toEqual([
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 100 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 20 },
    ]);
  });

  it('emits guardrail.validate rows from the same response', async () => {
    await harness.service.generateSummary('c-1', {} as never);

    const guardrailCall = harness.usageLedger.recordUsage.mock.calls.find((c) => c[0].common.operation === 'guardrail.validate');
    expect(guardrailCall).toBeDefined();
    expect(guardrailCall![1]).toBe(TX);
    expect(guardrailCall![0].common.idempotencyKey).toBe('guardrail:guard-1');
    expect(guardrailCall![0].common.provider).toBe('lm-studio');
    expect(guardrailCall![0].common.consultationId).toBe('c-1');
  });

  it('uses the presummarize operation on the pre-summary path', async () => {
    await harness.service.generatePreSummary('c-1', {} as never);

    const operations = harness.usageLedger.recordUsage.mock.calls.map((c) => c[0].common.operation);
    expect(operations).toContain('presummarize');
  });

  it('still persists the SummaryMeta when the ledger is not wired', async () => {
    const unwired = makeService({ usageLedger: null, unitOfWork: null });

    await expect(unwired.service.generateSummary('c-1', {} as never)).resolves.toBeDefined();
    expect(unwired.summaryMetaRepository.create).toHaveBeenCalled();
  });

  it('does not fail the generation when the ledger rejects', async () => {
    // The model already ran and the clinician is waiting for the draft. A
    // metering problem must degrade to "not metered", never to a 500 on a
    // delivered summary.
    const failing = makeService({
      usageLedger: { recordUsage: vi.fn().mockRejectedValue(new Error('outbox unavailable')) },
    });

    await expect(failing.service.generateSummary('c-1', {} as never)).resolves.toBeDefined();
    expect(failing.summaryMetaRepository.create).toHaveBeenCalled();
  });

  it('emits nothing when SMR returned no usage block (older service)', async () => {
    const legacy = makeService();
    legacy.httpService.axiosRef.post.mockResolvedValue({ data: { content: 'the summary', provider: 'openai', model: 'gpt-5' } });

    await legacy.service.generateSummary('c-1', {} as never);

    expect(legacy.usageLedger.recordUsage).not.toHaveBeenCalled();
    expect(legacy.summaryMetaRepository.create).toHaveBeenCalled();
  });
});
