/**
 * `ComprehensiveSummaryProcessor` makes its own
 * SMR `/generate` call (`callSmrService`) and was flagged in the WS-D
 * handoff as an unmetered `SummaryMeta` writer. This mirrors the
 * `summary.service.ts`/`chain-summary.service.ts` treatment: the SummaryMeta
 * write and the LLM (+ guardrail, when present) usage-ledger rows commit in
 * ONE transaction.
 *
 * Wired via the DOMAINS `CoreUnitOfWorkService` (from `@arcaai/domains`,
 * provided by `CoreDatabaseModule`) — NOT the identically-named, unwired
 * class under `services/baseServices` that `summary.service.ts` currently
 * (incorrectly) imports. See the sttInternal.service.ts / agent-trajectory
 * precedent for why that distinction matters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiUsageUnit } from '@arcaai/domains';
import { ComprehensiveSummaryProcessor } from '../processors/comprehensive-summary.processor';
import { GenerateComprehensiveSummaryJobPayload } from '../dto';

const TX = { __brand: 'tx' } as unknown as never;

const USAGE_DETAIL = {
  task_id: 'comp-task-1',
  request_id: 'corr-1',
  provider: 'lm-studio',
  model: 'medgemma',
  endpoint_kind: 'lmstudio.chat',
  interrupted: false,
  byok: false,
  occurred_at: '2026-08-06T10:00:00.000Z',
  prompt_tokens: 3000,
  completion_tokens: 800,
  total_tokens: 3800,
  raw: { prompt_tokens: 3000, completion_tokens: 800 },
};

const GUARDRAIL_USAGE_DETAIL = {
  task_id: 'guard-comp-1',
  provider: 'lm-studio',
  model: 'granite-guardian',
  endpoint_kind: 'lmstudio.chat',
  interrupted: false,
  byok: false,
  occurred_at: '2026-08-06T09:59:59.000Z',
  prompt_tokens: 200,
  completion_tokens: 3,
  total_tokens: 203,
  raw: { prompt_tokens: 200, completion_tokens: 3 },
};

function makeConsultation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'consultation-A',
    tenantId: 'tenant-1',
    patientId: 'patient-1',
    doctorId: 'doctor-A',
    departmentId: 'dept-general',
    appointmentDate: new Date('2026-02-17'),
    parentConsultationId: null,
    metadata: null,
    Doctor: { username: 'Dr. A' },
    Department: { name: 'General Medicine' },
    ...overrides,
  };
}

function makeSection(overrides: Record<string, unknown> = {}) {
  return {
    consultationId: 'consultation-A',
    department: 'General Medicine',
    doctor: 'Dr. A',
    type: 'summary',
    content: 'Patient presents with headache.',
    createdAt: '2026-02-17T09:00:00.000Z',
    ...overrides,
  };
}

function makeJob(data: GenerateComprehensiveSummaryJobPayload) {
  return { data, id: data.jobId, name: 'generate', timestamp: Date.now() } as never;
}

function makeHarness(overrides: { usageLedgerService?: unknown; unitOfWorkService?: unknown } = {}) {
  const jobService = { notifyProgress: vi.fn().mockResolvedValue(undefined), notifyComplete: vi.fn().mockResolvedValue(undefined), notifyFailed: vi.fn().mockResolvedValue(undefined) };
  const consultation = makeConsultation();
  const chainSummaryService = {
    resolveLinkedConsultations: vi.fn().mockResolvedValue([consultation]),
    gatherSections: vi.fn().mockResolvedValue([makeSection()]),
    gatherNamedEntities: vi.fn().mockResolvedValue({}),
  };
  const contextItemRepo = { create: vi.fn().mockImplementation((item) => Promise.resolve(item)), encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined) };
  const consultationRepo = { findById: vi.fn().mockResolvedValue(consultation) };
  const summaryMetaRepo = { create: vi.fn().mockResolvedValue({ id: 'meta-comprehensive-1' }) };
  const namedEntityRepo = { findByContextItem: vi.fn().mockResolvedValue([]) };
  const httpService = {
    axiosRef: {
      post: vi.fn().mockResolvedValue({
        data: {
          summary: 'Comprehensive summary generated.',
          modelName: 'medgemma',
          processingTimeMs: 5000,
          inputTokens: 3000,
          outputTokens: 800,
          usage_detail: USAGE_DETAIL,
          guardrail_usage: GUARDRAIL_USAGE_DETAIL,
        },
      }),
    },
  };
  const configService = { get: vi.fn((key: string) => (key === 'TEXT_URL' ? 'http://smr:8862' : undefined)) };
  const promptResolutionService = {
    resolve: vi.fn().mockResolvedValue({ template: 'comprehensive', promptId: 'prompt_default', contextVariables: {}, resolvedFrom: 'default', resolutionTrace: { usedDefaults: [] } }),
  };
  const promptAssemblyService = {
    assemble: vi.fn().mockImplementation((params: { transcript?: string }) =>
      Promise.resolve({ userPrompt: params.transcript ?? 'assembled', systemPrompt: '', hyperparameters: {}, responseFormat: null, resolvedFrom: 'default' }),
    ),
  };
  const jobMetrics = {
    recordJobStart: vi.fn().mockReturnValue(vi.fn().mockReturnValue(5.0)),
    recordJobComplete: vi.fn(),
    recordJobFailed: vi.fn(),
    recordWaitingDuration: vi.fn(),
    recordSmrCallDuration: vi.fn(),
  };
  const store = new Map<string, unknown>();
  const clsService = {
    run: vi.fn((...args: unknown[]) => (args.length === 1 ? args[0] : args[1])()),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
  const harnessPolicyService = { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'medgemma' }) };
  const configResolver = { resolvePreferredPromptTemplateId: vi.fn().mockResolvedValue(null) };
  const usageLedgerService = overrides.usageLedgerService ?? { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
  const unitOfWorkService = overrides.unitOfWorkService ?? { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX)) };

  const processor = new ComprehensiveSummaryProcessor(
    jobService as never,
    chainSummaryService as never,
    contextItemRepo as never,
    consultationRepo as never,
    summaryMetaRepo as never,
    namedEntityRepo as never,
    httpService as never,
    configService as never,
    promptResolutionService as never,
    promptAssemblyService as never,
    jobMetrics as never,
    clsService as never,
    undefined, // secretsService
    harnessPolicyService as never,
    configResolver as never,
    usageLedgerService as never,
    unitOfWorkService as never,
  );

  return { processor, summaryMetaRepo, httpService, usageLedgerService: usageLedgerService as { recordUsage: ReturnType<typeof vi.fn> }, unitOfWorkService };
}

describe('ComprehensiveSummaryProcessor — usage-ledger emission', () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('emits LLM token rows in the SAME transaction as the SummaryMeta write', async () => {
    await harness.processor.process(makeJob({ jobId: 'job-comp-1', consultationId: 'consultation-A', tenantId: 'tenant-1', userId: 'doctor-A', request: { includeNER: false } }));

    expect(harness.summaryMetaRepo.create).toHaveBeenCalledWith(expect.anything(), TX);

    const llmCall = harness.usageLedgerService.recordUsage.mock.calls.find((c) => c[0].common.operation === 'generate');
    expect(llmCall).toBeDefined();
    expect(llmCall![1]).toBe(TX);
    expect(llmCall![0].common.idempotencyKey).toBe('llm:comp-task-1');
    expect(llmCall![0].common.tenantId).toBe('tenant-1');
    expect(llmCall![0].common.consultationId).toBe('consultation-A');
    expect(llmCall![0].common.doctorId).toBe('doctor-A');
    expect(llmCall![0].common.departmentId).toBe('dept-general');
    expect(llmCall![0].units).toEqual([
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 3000 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 800 },
    ]);
  });

  it('emits guardrail.validate rows from the same response, in the same transaction', async () => {
    await harness.processor.process(makeJob({ jobId: 'job-comp-2', consultationId: 'consultation-A', tenantId: 'tenant-1', userId: 'doctor-A', request: { includeNER: false } }));

    const guardrailCall = harness.usageLedgerService.recordUsage.mock.calls.find((c) => c[0].common.operation === 'guardrail.validate');
    expect(guardrailCall).toBeDefined();
    expect(guardrailCall![1]).toBe(TX);
    expect(guardrailCall![0].common.idempotencyKey).toBe('guardrail:guard-comp-1');
  });

  it('still persists the SummaryMeta when the ledger is not wired', async () => {
    const unwired = makeHarness({ usageLedgerService: null, unitOfWorkService: null });

    await expect(
      unwired.processor.process(makeJob({ jobId: 'job-comp-3', consultationId: 'consultation-A', tenantId: 'tenant-1', userId: 'doctor-A', request: { includeNER: false } })),
    ).resolves.toBeDefined();
    expect(unwired.summaryMetaRepo.create).toHaveBeenCalled();
  });

  it('does not fail the job when the ledger rejects', async () => {
    const failing = makeHarness({ usageLedgerService: { recordUsage: vi.fn().mockRejectedValue(new Error('outbox unavailable')) } });

    await expect(
      failing.processor.process(makeJob({ jobId: 'job-comp-4', consultationId: 'consultation-A', tenantId: 'tenant-1', userId: 'doctor-A', request: { includeNER: false } })),
    ).resolves.toBeDefined();
    expect(failing.summaryMetaRepo.create).toHaveBeenCalled();
  });

  it('emits nothing when SMR returned no usage block (older service / partial response)', async () => {
    const legacy = makeHarness();
    legacy.httpService.axiosRef.post.mockResolvedValue({ data: { summary: 'Minimal response.' } });

    await legacy.processor.process(makeJob({ jobId: 'job-comp-5', consultationId: 'consultation-A', tenantId: 'tenant-1', userId: 'doctor-A', request: { includeNER: false } }));

    expect(legacy.usageLedgerService.recordUsage).not.toHaveBeenCalled();
    expect(legacy.summaryMetaRepo.create).toHaveBeenCalled();
  });
});
