/**
 * TASK-1050 finding D — the synchronous pre-summary's TEXT call (`SummaryService#callTextService`)
 * carries its guardrail attribution: the serving agent (`agent_slug`, the FALLBACK's own on a retry),
 * the consultation (`X-Hope-Consultation-Id`) and the CASE_NOTE items in its `case_notes` region.
 * The REAL `TextRequestEnrichmentService` builds the body.
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
  findCaseNotes: vi.fn().mockResolvedValue([
    { id: 'note-1', content: 'Prior case note.', currentVersionNumber: 3 },
    { id: 'note-2', content: '  ', currentVersionNumber: 1 },
  ]),
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

function buildService(opts: { generation?: Record<string, unknown>; fallbackGeneration?: Record<string, unknown> | null }) {
  const httpService = { axiosRef: { post: vi.fn() } };
  const harnessPolicyService = {
    resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'primary-provider', model: 'primary-model', generation: opts.generation, agentSlug: 'primary-agent' }),
    resolveTextFallbackSelection: vi
      .fn()
      .mockResolvedValue(
        opts.fallbackGeneration ? { provider: 'fallback-provider', model: 'fallback-model', generation: opts.fallbackGeneration, agentSlug: 'fallback-agent' } : null,
      ),
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

type Post = [string, Record<string, unknown>, { headers: Record<string, string> }];
const lastPost = (httpService: { axiosRef: { post: ReturnType<typeof vi.fn> } }) => httpService.axiosRef.post.mock.calls.at(-1) as Post;

beforeEach(() => vi.clearAllMocks());

describe('SummaryService (pre-summary) — guardrail attribution on the TEXT call', () => {
  it('names the agent, the consultation and the case-note items', async () => {
    const { service, httpService } = buildService({});
    httpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });

    await service.generatePreSummary('c-1', {} as any);

    const [, body, config] = lastPost(httpService);
    expect(body.agent_slug).toBe('primary-agent');
    expect(body.region_items).toEqual({ case_notes: [{ itemId: 'note-1', itemVersion: 3 }] });
    expect(config.headers['X-Hope-Consultation-Id']).toBe('c-1');
  });

  it('a fallback retry names the fallback agent', async () => {
    const { service, httpService } = buildService({ fallbackGeneration: { temperature: 0.1 } });
    const err = Object.assign(new Error('TEXT provider error'), { response: { status: 502, data: {} } });
    httpService.axiosRef.post.mockRejectedValueOnce(err).mockResolvedValueOnce({ data: { summary: 'S', modelName: 'fb' } });

    await service.generatePreSummary('c-1', {} as any);

    expect(lastPost(httpService)[1].agent_slug).toBe('fallback-agent');
  });
});
