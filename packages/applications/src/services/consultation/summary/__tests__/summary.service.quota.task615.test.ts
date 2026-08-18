/**
 * LLM-token quota pre-flight at the summary generation entry
 * points.
 *
 * `assertMeterQuota` (existing 429 semantics, kill-switch-gated, null
 * allowance = unlimited) is wired for `monthlyLlmTokens` at BOTH
 * `generatePreSummary` and `generateSummary`, alongside the pre-existing
 * `monthlySummaries` check — same "post-hoc debit" call shape (no caller-
 * supplied increment; the check compares month-to-date rollups against the
 * allowance BEFORE the SMR call, since a request's own eventual token count
 * is unknowable in advance). A block must abort BEFORE the (expensive) SMR
 * call, the same way the existing `monthlySummaries` check does.
 *
 * Guardrail is explicitly exempt (D6/D16): this file also proves no quota
 * path ever gates the guardrail usage this same generation call produces.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaExceededException } from '@arcaai/exceptions';
import { SummaryService } from '../summary.service';

function makeService(overrides: { entitlements?: unknown } = {}) {
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
          provider: 'openai',
          model: 'gpt-5',
          usage: { prompt_tokens: 100, completion_tokens: 20 },
          usage_detail: {
            task_id: 'smr-task-1',
            provider: 'openai',
            model: 'gpt-5',
            endpoint_kind: 'openai.chat',
            interrupted: false,
            byok: false,
            occurred_at: '2026-08-06T10:00:00.000Z',
            prompt_tokens: 100,
            completion_tokens: 20,
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
  const entitlements = overrides.entitlements ?? { assertMeterQuota: vi.fn().mockResolvedValue(undefined) };
  const usageLedger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
  const unitOfWork = { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})) };

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
    { getSecretOptional: vi.fn().mockResolvedValue('') } as never, // secretsService
    undefined, // userProfileRepository
    undefined, // harnessAuditService
    undefined, // harnessGatewayService
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'openai', model: 'gpt-5' }) } as never,
    undefined, // configResolver
    entitlements as never,
    undefined, // trajectoryService
    undefined, // aiTaskDefaultService
    undefined, // transcriptSegmentRepository
    usageLedger as never,
    unitOfWork as never,
  );

  return { service, httpService, entitlements: entitlements as { assertMeterQuota: ReturnType<typeof vi.fn> } };
}

describe('SummaryService — LLM-token quota pre-flight', () => {
  let harness: ReturnType<typeof makeService>;

  beforeEach(() => {
    harness = makeService();
  });

  it('generateSummary checks BOTH monthlySummaries and monthlyLlmTokens before calling SMR', async () => {
    await harness.service.generateSummary('c-1', {} as never);

    const capabilities = harness.entitlements.assertMeterQuota.mock.calls.map((c) => c[1]);
    expect(capabilities).toEqual(['monthlySummaries', 'monthlyLlmTokens']);
    expect(harness.entitlements.assertMeterQuota.mock.calls[0][0]).toBe('tenant-1');
    expect(harness.entitlements.assertMeterQuota.mock.calls[1][0]).toBe('tenant-1');
  });

  it('generatePreSummary checks BOTH monthlySummaries and monthlyLlmTokens before calling SMR', async () => {
    await harness.service.generatePreSummary('c-1', {} as never);

    const capabilities = harness.entitlements.assertMeterQuota.mock.calls.map((c) => c[1]);
    expect(capabilities).toEqual(['monthlySummaries', 'monthlyLlmTokens']);
  });

  it('aborts BEFORE the SMR call when the LLM-token allowance is exceeded', async () => {
    const entitlements = {
      assertMeterQuota: vi.fn(async (_tenantId: string, capability: string) => {
        if (capability === 'monthlyLlmTokens') {
          throw new QuotaExceededException('over allowance', { capability, limit: 1000, used: 1000, requested: 1, tenantId: 'tenant-1' });
        }
      }),
    };
    const blocked = makeService({ entitlements });

    await expect(blocked.service.generateSummary('c-1', {} as never)).rejects.toBeInstanceOf(QuotaExceededException);
    expect(blocked.httpService.axiosRef.post).not.toHaveBeenCalled();
  });

  it('still generates when monthlyLlmTokens is within the allowance (no-op kill-switch/null-allowance case)', async () => {
    await expect(harness.service.generateSummary('c-1', {} as never)).resolves.toBeDefined();
    expect(harness.httpService.axiosRef.post).toHaveBeenCalledTimes(1);
  });

  it('is a no-op (never throws) when entitlements is not wired — legacy positional fixtures', async () => {
    const unwired = makeService({ entitlements: undefined });
    await expect(unwired.service.generateSummary('c-1', {} as never)).resolves.toBeDefined();
  });

  describe('guardrail exemption (D6/D16) — no quota path ever gates guardrail.validate', () => {
    it('never calls assertMeterQuota with a guardrail-related capability, even though this call also produces guardrail usage', async () => {
      await harness.service.generateSummary('c-1', {} as never);

      const capabilities = harness.entitlements.assertMeterQuota.mock.calls.map((c) => c[1]);
      expect(capabilities.some((c) => String(c).toLowerCase().includes('guardrail'))).toBe(false);
    });

    it('the guardrail usage this call produces is still recorded on the ledger — metered, just never quota-checked', async () => {
      const unitOfWork = { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})) };
      const usageLedger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
      // Rebuild with a spy-visible ledger (the default harness ledger is opaque here).
      const contextItemRepository = {
        findById: vi.fn(),
        findCaseNotes: vi.fn().mockResolvedValue([{ id: 'note-1', content: 'x' }]),
        findTranscripts: vi.fn().mockResolvedValue([{ id: 't-1', content: 'x' }]),
        findLatestPreSummary: vi.fn().mockResolvedValue(null),
  findLatestPreSummaryWithDecryptedContent: vi.fn().mockResolvedValue({ entity: null, plaintext: null }),
        create: vi.fn().mockResolvedValue({ id: 'ctx-new', content: 'S', createdAt: new Date(), updatedAt: new Date() }),
        encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
      };
      const consultationRepository = {
        findById: vi.fn().mockResolvedValue({ id: 'c-1', tenantId: 'tenant-1', doctorId: 'doc-1', departmentId: 'dept-1' }),
      };
      const summaryMetaRepository = { create: vi.fn().mockResolvedValue({ id: 'meta-1' }), encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined) };
      const httpService = harness.httpService;
      const clsService = { get: vi.fn((k: string) => (k === 'tenantId' ? 'tenant-1' : k === 'user' ? { id: 'user-1' } : null)), set: vi.fn(), run: vi.fn((cb: () => unknown) => cb()) };
      const promptAssemblyService = {
        assemble: vi.fn().mockResolvedValue({ userPrompt: 'u', systemPrompt: 's', hyperparameters: {}, responseFormat: null, resolvedFrom: 'default', promptId: 'p-1' }),
      };
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
        { getSecretOptional: vi.fn().mockResolvedValue('') } as never,
        undefined,
        undefined,
        undefined,
        { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'openai', model: 'gpt-5' }) } as never,
        undefined,
        harness.entitlements as never,
        undefined,
        undefined,
        undefined,
        usageLedger as never,
        unitOfWork as never,
      );

      await service.generateSummary('c-1', {} as never);

      const guardrailCall = usageLedger.recordUsage.mock.calls.find((c) => c[0].common.operation === 'guardrail.validate');
      expect(guardrailCall).toBeDefined();
    });
  });
});
