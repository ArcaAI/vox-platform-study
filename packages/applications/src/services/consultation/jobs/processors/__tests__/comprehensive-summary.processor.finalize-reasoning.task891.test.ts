/**
 * TASK-891 (finalize tier) — ComprehensiveSummaryProcessor (the async job twin of
 * ChainSummaryService) must carry the resolved agent's reasoning posture onto the wire.
 *
 * Its own `callTextService` resolves `{ provider, model, generation }` via
 * `HarnessPolicyService.resolveTextSelection(tenantId, 'finalize')` and then called
 * `applyTextRuntimeProfile(textPayload)` with NO second argument — the agent's
 * `parameters.generation.reasoning` block never reached the `extra` ride-along.
 *
 * The REAL `TextRequestEnrichmentService` is used (not a double): the claim under test is about
 * the body that service builds, so a stub would assert nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComprehensiveSummaryProcessor } from '../comprehensive-summary.processor';
import { TextRequestEnrichmentService } from '../../../../text-request/text-request-enrichment.service';

const TENANT = 'tenant-1';

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

const consultation = {
  id: 'consult-1',
  tenantId: TENANT,
  departmentId: null as string | null,
  parentConsultationId: null as string | null,
  doctorId: 'doctor-1',
};

/** The REAL enrichment service — a stubbed one would assert nothing about the body it builds. */
const enrichment = () => new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined);

function buildProcessor(generation: Record<string, unknown>) {
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
  const consultationRepository = { findById: vi.fn().mockResolvedValue(consultation) };
  const summaryMetaRepository = {
    create: vi.fn().mockResolvedValue({ id: 'meta-1' }),
    encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const namedEntityRepository = { create: vi.fn() };
  const httpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'Result.' } }) } };
  const configService = { get: vi.fn().mockImplementation((key: string) => (key === 'TEXT_URL' ? 'http://text.test' : undefined)) };
  const promptResolutionService = { resolve: vi.fn() };
  const promptAssemblyService = {
    assemble: vi.fn().mockResolvedValue({ userPrompt: 'assembled', systemPrompt: 'system', hyperparameters: {}, responseFormat: null, resolvedFrom: 'tenant' }),
  };
  const jobMetrics = {
    recordJobStart: vi.fn(() => () => 1),
    recordWaitingDuration: vi.fn(),
    recordJobComplete: vi.fn(),
    recordJobFailed: vi.fn(),
    recordTextCallDuration: vi.fn(),
  };
  const cls = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()), set: vi.fn(), get: vi.fn() };
  const harnessPolicyService = {
    resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'resolved-medgemma', generation }),
  };

  const processor = new ComprehensiveSummaryProcessor(
    jobService as any,
    chainSummaryService as any,
    contextItemRepository as any,
    consultationRepository as any,
    summaryMetaRepository as any,
    namedEntityRepository as any,
    httpService as any,
    configService as any,
    promptResolutionService as any,
    promptAssemblyService as any,
    jobMetrics as any,
    cls as any,
    undefined, // secretsService
    harnessPolicyService as any,
    undefined, // configResolver
    undefined, // usageLedgerService
    undefined, // unitOfWorkService
    undefined, // noteGenerationService
    enrichment() as any, // textRequestEnrichment — REAL
  );

  return { processor, httpService };
}

const job = () =>
  ({
    id: 'bull-1',
    timestamp: Date.now(),
    data: {
      jobId: 'job-1',
      consultationId: 'consult-1',
      tenantId: TENANT,
      userId: 'user-1',
      request: { template: 'comprehensive', includeNER: false },
    },
  }) as any;

const lastPostBody = (httpService: { axiosRef: { post: ReturnType<typeof vi.fn> } }) =>
  httpService.axiosRef.post.mock.calls.at(-1)![1] as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

describe('TASK-891 — ComprehensiveSummaryProcessor carries the resolved agent`s reasoning posture', () => {
  it('an agent that disabled reasoning instructs the engine not to reason', async () => {
    const { processor, httpService } = buildProcessor({ temperature: 0.1, reasoning: { enabled: false } });

    await processor.process(job());

    expect(lastPostBody(httpService).extra).toEqual({ reasoning_effort: 'minimal' });
  });

  it('an agent that named an effort sends that effort', async () => {
    const { processor, httpService } = buildProcessor({ reasoning: { enabled: true, effort: 'medium' } });

    await processor.process(job());

    expect(lastPostBody(httpService).extra).toEqual({ reasoning_effort: 'medium' });
  });

  it('an agent with no reasoning opinion sends no `extra` key at all', async () => {
    const { processor, httpService } = buildProcessor({ temperature: 0.1 });

    await processor.process(job());

    expect(Object.keys(lastPostBody(httpService))).not.toContain('extra');
  });
});
