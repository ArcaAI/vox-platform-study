/**
 * TASK-891 (finalize tier) — PreSummaryProcessor must carry the resolved agent's reasoning
 * posture onto the wire, exactly as the live tier already does.
 *
 * Its own `callTextService` resolves `{ provider, model, generation }` via
 * `HarnessPolicyService.resolveTextSelection(tenantId, 'finalize')` and then called
 * `applyTextRuntimeProfile(textPayload)` with NO second argument — the agent's
 * `parameters.generation.reasoning` block never reached the `extra` ride-along.
 *
 * The REAL `TextRequestEnrichmentService` is used (not a double): the claim under test is about
 * the body that service builds, so a stub would assert nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreSummaryProcessor } from '../pre-summary.processor';
import { TextRequestEnrichmentService } from '../../../../text-request/text-request-enrichment.service';

const TENANT = 'tenant-1';

const CONSULTATION = {
  id: 'consult-1',
  tenantId: TENANT,
  departmentId: null as string | null,
  parentConsultationId: null as string | null,
  doctorId: 'doctor-1',
};

/** The REAL enrichment service — a stubbed one would assert nothing about the body it builds. */
const enrichment = () => new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined);

function buildProcessor(generation: Record<string, unknown>) {
  const promptResolutionService = {
    resolve: vi.fn().mockResolvedValue({ resolvedFrom: 'tenant', template: 'Pre-Summary', promptId: 'p1' }),
  };
  const promptAssemblyService = {
    assemble: vi.fn().mockResolvedValue({ userPrompt: 'assembled', systemPrompt: 'system', hyperparameters: {}, responseFormat: null, resolvedFrom: 'tenant' }),
  };
  const jobService = {
    notifyProgress: vi.fn().mockResolvedValue(undefined),
    notifyComplete: vi.fn().mockResolvedValue(undefined),
    notifyFailed: vi.fn().mockResolvedValue(undefined),
  };
  const contextItemRepository = {
    findByConsultation: vi.fn().mockResolvedValue([{ id: 'note-1', content: 'Chest pain for three days.' }]),
    findById: vi.fn(),
    create: vi.fn().mockImplementation(async (entity: any) => ({ id: 'ctx-1', content: entity.content })),
    encryptContentIntoEntity: vi.fn(),
  };
  const consultationRepository = { findById: vi.fn().mockResolvedValue(CONSULTATION) };
  const httpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'PRE-SUMMARY' } }) } };
  const configService = { get: vi.fn(() => 'http://text.test') };
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

  const processor = new PreSummaryProcessor(
    jobService as any,
    contextItemRepository as any,
    consultationRepository as any,
    httpService as any,
    configService as any,
    promptResolutionService as any,
    promptAssemblyService as any,
    jobMetrics as any,
    cls as any,
    undefined, // secretsService
    harnessPolicyService as any,
    undefined, // configResolver
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
      request: { options: {} },
    },
  }) as any;

const lastPostBody = (httpService: { axiosRef: { post: ReturnType<typeof vi.fn> } }) =>
  httpService.axiosRef.post.mock.calls.at(-1)![1] as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

describe('TASK-891 — PreSummaryProcessor carries the resolved agent`s reasoning posture', () => {
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
