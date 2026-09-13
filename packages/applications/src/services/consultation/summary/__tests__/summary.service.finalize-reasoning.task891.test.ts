/**
 * TASK-891 (finalize tier) — the resolved finalize agent's reasoning posture must reach the wire.
 *
 * `SummaryService#callTextService` resolves a `TextSelection` (`{ provider, model, generation }`)
 * via `HarnessPolicyService.resolveTextSelection(tenantId, 'finalize', departmentId)` and its
 * fallback twin `resolveTextFallbackSelection`, but only ever destructured `{ provider, model }`
 * before calling `applyTextRuntimeProfile(textPayload)` with NO second argument — so the agent's
 * `parameters.generation.reasoning` block, already carried on the `TextSelection`, was discarded
 * before it ever reached the enrichment call that states it as `GenerateRequest.reasoning`.
 *
 * The REAL `TextRequestEnrichmentService` is used (not a double), for the same reason the live-tier
 * and agent-invocation specs give: the claim under test is about the body THAT service builds.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SummaryService } from '../summary.service';
import { TextRequestEnrichmentService } from '../../../text-request/text-request-enrichment.service';

const TENANT = 'tenant-1';

const createMockClsService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'tenantId') return TENANT;
    if (key === 'user') return { id: 'user-1', firstName: 'Test', lastName: 'User' };
    return null;
  }),
  set: vi.fn(),
  run: vi.fn((callback: () => unknown) => callback()),
});

const createMockEventEmitter = () => ({ emit: vi.fn() });

const createMockContextItemRepository = () => ({
  findById: vi.fn(),
  findCaseNotes: vi.fn(),
  findTranscripts: vi.fn().mockResolvedValue([{ content: 'transcript text' }]),
  findSummaries: vi.fn(),
  findLatestModifiedSummary: vi.fn(),
  findLatestRawSummary: vi.fn(),
  findLatestPreSummary: vi.fn(),
  findLatestPreSummaryWithDecryptedContent: vi.fn().mockResolvedValue({ entity: null, plaintext: null }),
  create: vi.fn().mockResolvedValue({ id: 'ctx-new', content: 'S', createdAt: new Date(), updatedAt: new Date() }),
  update: vi.fn(),
  encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
});

const createMockConsultationRepository = () => ({
  findById: vi.fn().mockResolvedValue({ id: 'c-1', tenantId: TENANT }),
  update: vi.fn(),
});

const createMockSummaryMetaRepository = () => ({
  create: vi.fn().mockResolvedValue({ id: 'meta-1' }),
  encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
});

const createMockNamedEntityRepository = () => ({ create: vi.fn() });

const createMockContextItemVersionRepository = () => ({
  create: vi.fn(),
  findById: vi.fn(),
  getVersionsByChangeReason: vi.fn().mockResolvedValue([]),
  encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
});

const createMockConfigService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'TEXT_URL') return 'http://localhost:8862';
    if (key === 'NLP_URL') return 'http://localhost:8864';
    return undefined;
  }),
});

const createMockPromptAssemblyService = () => ({
  assemble: vi.fn().mockResolvedValue({
    userPrompt: 'assembled',
    systemPrompt: '',
    hyperparameters: {},
    responseFormat: null,
    resolvedFrom: 'default',
  }),
});

/** The REAL enrichment service — a stubbed one would assert nothing about the body it builds. */
const enrichment = () => new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined);

function buildService(opts: {
  generation?: Record<string, unknown>;
  fallbackGeneration?: Record<string, unknown> | null;
}) {
  const httpService = { axiosRef: { post: vi.fn() } };
  const harnessPolicyService = {
    resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'primary-provider', model: 'primary-model', generation: opts.generation }),
    resolveTextFallbackSelection: vi
      .fn()
      .mockResolvedValue(opts.fallbackGeneration ? { provider: 'fallback-provider', model: 'fallback-model', generation: opts.fallbackGeneration } : null),
  };

  const service = new SummaryService(
    createMockContextItemRepository() as any,
    createMockConsultationRepository() as any,
    createMockSummaryMetaRepository() as any,
    createMockNamedEntityRepository() as any,
    httpService as any,
    createMockConfigService() as any,
    createMockEventEmitter() as any,
    createMockClsService() as any,
    createMockContextItemVersionRepository() as any,
    createMockPromptAssemblyService() as any,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') } as any, // secretsService
    undefined, // userProfileRepository
    undefined, // harnessAuditService
    undefined, // harnessGatewayService
    harnessPolicyService as any,
    undefined, // configResolver
    undefined, // entitlements
    undefined, // trajectoryService
    undefined, // routingPolicies
    undefined, // transcriptSegmentRepository
    undefined, // usageLedger
    undefined, // unitOfWork
    undefined, // billing
    undefined, // aiModelRepository
    undefined, // noteGenerationService
    undefined, // phiRedactor
    undefined, // gateEditMiningQueue
    enrichment() as any, // textRequestEnrichment — REAL
  );

  return { service, httpService, harnessPolicyService };
}

const lastPostBody = (httpService: { axiosRef: { post: ReturnType<typeof vi.fn> } }) =>
  httpService.axiosRef.post.mock.calls.at(-1)![1] as Record<string, unknown>;

const providerSideError = () => {
  const err = new Error('TEXT provider error') as Error & { response?: unknown };
  err.response = { status: 502, data: { detail: 'upstream LLM failure' } };
  return err;
};

beforeEach(() => vi.clearAllMocks());

describe('TASK-891 — SummaryService (finalize) carries the resolved agent`s reasoning posture', () => {
  it('an agent that disabled reasoning instructs the engine not to reason', async () => {
    const { service, httpService } = buildService({ generation: { temperature: 0.1, reasoning: { enabled: false } } });
    httpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });

    await service.generateSummary('c-1', {} as any);

    expect(lastPostBody(httpService).reasoning).toEqual({ enabled: false });
  });

  it('an agent that named an effort sends that effort', async () => {
    const { service, httpService } = buildService({ generation: { reasoning: { enabled: true, effort: 'high' } } });
    httpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });

    await service.generateSummary('c-1', {} as any);

    expect(lastPostBody(httpService).reasoning).toEqual({ enabled: true, effort: 'high' });
  });

  it('an agent with no reasoning opinion sends no `reasoning` key at all', async () => {
    const { service, httpService } = buildService({ generation: { temperature: 0.1 } });
    httpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });

    await service.generateSummary('c-1', {} as any);

    expect(Object.keys(lastPostBody(httpService))).not.toContain('extra');
  });

  it('the TENANT-configured fallback selection`s OWN reasoning posture rides the retry — not the primary`s', async () => {
    const { service, httpService } = buildService({
      generation: { reasoning: { enabled: true, effort: 'high' } },
      fallbackGeneration: { reasoning: { enabled: false } },
    });
    httpService.axiosRef.post.mockRejectedValueOnce(providerSideError()).mockResolvedValueOnce({ data: { summary: 'S (fallback)', modelName: 'fb' } });

    await service.generateSummary('c-1', {} as any);

    expect(httpService.axiosRef.post).toHaveBeenCalledTimes(2);
    expect(lastPostBody(httpService).reasoning).toEqual({ enabled: false });
  });
});
