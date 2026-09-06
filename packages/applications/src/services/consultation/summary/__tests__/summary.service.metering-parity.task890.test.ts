/**
 * TASK-890 L11 (§3.13) — metering parity on the clinical paths.
 *
 * Two gaps, both of the same shape: work that was RECORDED but never GATED,
 * and rows that could not say WHICH activity produced them.
 *
 *   1. `extractEntities` emits a `ner.extract` row and never checks
 *      `monthlyNlpTextUnits` — the allowance existed and nothing consulted it.
 *   2. The summary/pre-summary LLM rows carry no `trigger`, so a tenant whose
 *      spend doubled cannot be told whether that was clinicians consulting or
 *      one engineer looping a prompt test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaExceededException } from '@arcaai/exceptions';
import { SummaryService } from '../summary.service';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return { ...actual, NamedEntityFactory: { CreateNamedEntity: vi.fn((data) => ({ id: 'temp-id', ...data })) } };
});

const TENANT = 'tenant-1';

function textResponse() {
  return {
    data: {
      content: 'the summary',
      provider: 'openai',
      model: 'gpt-5',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      usage_detail: {
        task_id: 'text-task-1',
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
  };
}

function cls() {
  return {
    get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1' } : null)),
    set: vi.fn(),
    run: vi.fn((cb: () => unknown) => cb()),
  };
}

/** The generation harness (the `summary.service.quota.task615` fixture shape). */
function makeGenerationService(entitlements?: unknown) {
  const usageLedger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
  const httpService = { axiosRef: { post: vi.fn().mockResolvedValue(textResponse()) } };
  const service = new SummaryService(
    {
      findById: vi.fn(),
      findCaseNotes: vi.fn().mockResolvedValue([{ id: 'note-1', content: 'case note text' }]),
      findTranscripts: vi.fn().mockResolvedValue([{ id: 't-1', content: 'transcript text' }]),
      findLatestPreSummary: vi.fn().mockResolvedValue(null),
      findLatestPreSummaryWithDecryptedContent: vi.fn().mockResolvedValue({ entity: null, plaintext: null }),
      create: vi.fn().mockResolvedValue({ id: 'ctx-new', content: 'S', createdAt: new Date(), updatedAt: new Date() }),
      encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
    } as never,
    { findById: vi.fn().mockResolvedValue({ id: 'c-1', tenantId: TENANT, doctorId: 'doc-1', departmentId: 'dept-1' }) } as never,
    { create: vi.fn().mockResolvedValue({ id: 'meta-1' }), encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined) } as never,
    { create: vi.fn() } as never,
    httpService as never,
    { get: vi.fn(() => 'http://text') } as never,
    { emit: vi.fn() } as never,
    cls() as never,
    { create: vi.fn() } as never,
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
    undefined,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'openai', model: 'gpt-5' }) } as never,
    undefined,
    (entitlements ?? { assertMeterQuota: vi.fn().mockResolvedValue(undefined) }) as never,
    undefined,
    undefined,
    undefined,
    usageLedger as never,
    { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})) } as never,
  );
  return { service, usageLedger, httpService };
}

describe('SummaryService — the CONSULTATION activity dimension', () => {
  it('stamps trigger CONSULTATION on the LLM row a summary produced', async () => {
    const { service, usageLedger } = makeGenerationService();
    await service.generateSummary('c-1', {} as never);

    const llm = usageLedger.recordUsage.mock.calls
      .map((call) => call[0] as { common: { operation: string; attributesJson?: Record<string, unknown> } })
      .find((batch) => batch.common.operation === 'generate');
    expect(llm).toBeDefined();
    expect(llm!.common.attributesJson).toMatchObject({ trigger: 'CONSULTATION' });
  });

  it('stamps it on the guardrail row of the same call too — one activity, every row it produced', async () => {
    const { service, usageLedger } = makeGenerationService();
    await service.generateSummary('c-1', {} as never);

    const guard = usageLedger.recordUsage.mock.calls
      .map((call) => call[0] as { common: { operation: string; attributesJson?: Record<string, unknown> } })
      .find((batch) => batch.common.operation === 'guardrail.validate');
    expect(guard).toBeDefined();
    expect(guard!.common.attributesJson).toMatchObject({ trigger: 'CONSULTATION' });
  });
});

describe('SummaryService.extractEntities — the NLP allowance is checked before the call', () => {
  const RAW = 'Patient John Doe, diagnosed with Type 2 Diabetes.';

  function makeNerService(entitlements?: unknown, usageLedger?: unknown) {
    const httpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { entities: [] } }) } };
    const service = new SummaryService(
      { findById: vi.fn().mockResolvedValue({ id: 'ctx-1', tenantId: TENANT, consultationId: 'c-1', content: RAW, changes: {} }) } as never,
      { findById: vi.fn(), update: vi.fn(), updateWithVersion: vi.fn() } as never,
      { create: vi.fn(), findByContextItem: vi.fn().mockResolvedValue(null), encryptFieldsIntoEntity: vi.fn() } as never,
      { create: vi.fn().mockResolvedValue({ id: 'entity-1' }) } as never,
      httpService as never,
      { get: vi.fn((key: string) => (key === 'NLP_URL' ? 'http://nlp' : undefined)) } as never,
      { emit: vi.fn() } as never,
      cls() as never,
      { create: vi.fn() } as never,
      { assemble: vi.fn() } as never,
      undefined, // secretsService
      undefined, // userProfileRepository
      undefined, // harnessAuditService
      undefined, // harnessGatewayService
      undefined, // harnessPolicyService
      undefined, // configResolver
      (entitlements ?? { assertMeterQuota: vi.fn().mockResolvedValue(undefined) }) as never,
      undefined, // trajectoryService
      { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
      undefined, // transcriptSegmentRepository
      (usageLedger ?? { recordUsage: vi.fn().mockResolvedValue({ outboxIds: [], events: 1 }) }) as never,
      undefined, // unitOfWork
      undefined, // billing
      undefined, // aiModelRepository
      undefined, // noteGenerationService
      { redact: vi.fn().mockResolvedValue(RAW) } as never, // phiRedactor
    );
    return { service, httpService };
  }

  const nlpCall = (httpService: { axiosRef: { post: ReturnType<typeof vi.fn> } }) =>
    httpService.axiosRef.post.mock.calls.find((call: unknown[]) => String(call[0]).includes('/api/v1/classify/tokens'));

  beforeEach(() => vi.clearAllMocks());

  it('prechecks `monthlyNlpTextUnits` for the caller tenant', async () => {
    const entitlements = { assertMeterQuota: vi.fn().mockResolvedValue(undefined) };
    const { service } = makeNerService(entitlements);
    await service.extractEntities('ctx-1');
    expect(entitlements.assertMeterQuota).toHaveBeenCalledWith(TENANT, 'monthlyNlpTextUnits');
  });

  it('aborts BEFORE the NLP call when the allowance is exhausted', async () => {
    const entitlements = {
      assertMeterQuota: vi.fn().mockRejectedValue(
        new QuotaExceededException('over allowance', { capability: 'monthlyNlpTextUnits', limit: 10, used: 10, requested: 1, tenantId: TENANT }),
      ),
    };
    const { service, httpService } = makeNerService(entitlements);
    await expect(service.extractEntities('ctx-1')).rejects.toBeInstanceOf(QuotaExceededException);
    expect(nlpCall(httpService)).toBeUndefined();
  });

  it('extracts normally when entitlements is not wired (metering is additive)', async () => {
    const { service, httpService } = makeNerService(null);
    await expect(service.extractEntities('ctx-1')).resolves.toBeUndefined();
    expect(nlpCall(httpService)).toBeDefined();
  });
});
