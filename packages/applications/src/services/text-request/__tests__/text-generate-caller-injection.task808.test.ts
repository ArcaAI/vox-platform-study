/**
 * every TEXT `/api/v1/generate` caller must POST a body carrying
 * `provider_overrides[provider]`.
 *
 * The companion `text-generate-caller-coverage.test.ts` is the STRUCTURAL gate:
 * it scans the source so a NEW caller cannot be added without an injector. This
 * file is the BEHAVIOURAL half — it drives the real payload-building code of
 * each of the six callers repaired and inspects what actually reaches
 * `axiosRef.post`. Both are needed: the scan cannot prove the injector runs on
 * the path that posts, and a behavioural test cannot see a caller nobody wrote
 * a test for.
 *
 * Each case calls the private TEXT-calling method directly. That is deliberate:
 * it is the smallest unit that owns "build the body, then post it", and driving
 * the whole job/flush around it would test the orchestration rather than the
 * enrichment.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../../consultation/live-documentation/live-documentation.service';
import { PreSummaryProcessor } from '../../consultation/jobs/processors/pre-summary.processor';
import { ComprehensiveSummaryProcessor } from '../../consultation/jobs/processors/comprehensive-summary.processor';
import { ChainSummaryService } from '../../consultation/summary/chain-summary.service';
import { SummaryService } from '../../consultation/summary/summary.service';
import { DnaWritingStyleProcessor } from '../../dna-writing-style/dna-writing-style.processor';

const TENANT = 'tenant-808';
const PROVIDER = 'azure';
const ENTRY = { api_key: 'k', base_url: 'https://example.invalid/v1', funding: 'byok' };

/**
 * Stands in for `TextRequestEnrichmentService`. It performs the SAME mutation
 * the real service performs on a resolved entry (`body.provider_overrides =
 * { [provider]: entry }`) — the real resolver's tenant → SYSTEM cascade and its
 * fail-open/policy-refusal split are already covered by
 * `text-request-enrichment.service.test.ts`. What is under test HERE is whether
 * each caller routes its outgoing body through that mutation at all.
 */
function enrichmentStub() {
  return {
    applyTenantProviderOverrides: vi.fn(async (body: Record<string, unknown>) => {
      body.provider_overrides = { [String(body.provider ?? PROVIDER)]: ENTRY };
      return body;
    }),
    applyTextRuntimeProfile: vi.fn(async (body: unknown) => body),
    applyTenantGuardrailPolicy: vi.fn(async (body: unknown) => body),
  };
}

function httpStub() {
  return { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'S', content: 'S', modelName: 'm' } }) } };
}

const configStub = { get: vi.fn().mockReturnValue('http://text.invalid') } as never;
const policyStub = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: PROVIDER, model: 'gpt-x' }) } as never;
const secretsStub = { getSecretOptional: vi.fn().mockResolvedValue(''), encrypt: vi.fn(), decrypt: vi.fn() } as never;
const metricsStub = { recordTextCallDuration: vi.fn(), recordJobStart: vi.fn(() => vi.fn()), recordWaitingDuration: vi.fn() } as never;

function clsStub(store: Record<string, unknown> = { tenantId: TENANT }) {
  return {
    run: vi.fn((cb: () => unknown) => cb()),
    set: vi.fn((k: string, v: unknown) => void (store[k] = v)),
    get: vi.fn((k?: string) => (k === undefined ? store : store[k])),
    has: vi.fn((k: string) => k in store),
    isActive: vi.fn(() => true),
  } as never;
}

const ASSEMBLED = {
  userPrompt: 'transcript',
  systemPrompt: 'sys',
  hyperparameters: {},
  responseFormat: null,
  resolvedFrom: 'default',
} as never;

/** The single assertion every case makes on what actually went over the wire. */
function expectOverridesPosted(post: ReturnType<typeof vi.fn>): void {
  expect(post, 'the caller never POSTed to TEXT').toHaveBeenCalled();
  const body = post.mock.calls[0][1] as Record<string, unknown>;
  expect(body.provider_overrides, `posted body: ${JSON.stringify(Object.keys(body))}`).toEqual({ [PROVIDER]: ENTRY });
}

describe('each TEXT /generate caller posts provider_overrides', () => {
  it('LiveDocumentationService.callText (the live-flush loop)', async () => {
    const http = httpStub();
    const enrichment = enrichmentStub();
    const service = new LiveDocumentationService(
      http as never,
      configStub,
      { get: vi.fn(), set: vi.fn() } as never, // cacheService
      { subscribe: vi.fn(), unsubscribe: vi.fn() } as never, // redisSubscriber
      undefined, // audioBridge
      undefined, // contextItemRepository
      policyStub,
      secretsStub,
      undefined, // trajectoryService
      undefined, // effectiveSettings
      undefined, // aiTaskDefaultService
      clsStub(),
      undefined, // liveAgentResolver
      enrichment as never,
    );

    await (service as never as { callText(p: string, t: string): Promise<unknown> }).callText('transcript delta', TENANT);

    expectOverridesPosted(http.axiosRef.post);
  });

  it('PreSummaryProcessor.callTextService (OD-9 exemption path)', async () => {
    const http = httpStub();
    const enrichment = enrichmentStub();
    const processor = new PreSummaryProcessor(
      { notifyProgress: vi.fn() } as never,
      {} as never, // contextItemRepository
      {} as never, // consultationRepository
      http as never,
      configStub,
      {} as never, // promptResolutionService
      {} as never, // promptAssemblyService
      metricsStub,
      clsStub(),
      secretsStub,
      policyStub,
      undefined, // configResolver
      undefined, // noteGenerationService
      enrichment as never,
    );

    await (processor as never as { callTextService(a: unknown, r: unknown, t: string): Promise<unknown> }).callTextService(
      ASSEMBLED,
      {},
      TENANT,
    );

    expectOverridesPosted(http.axiosRef.post);
  });

  it('ComprehensiveSummaryProcessor.callTextService', async () => {
    const http = httpStub();
    const enrichment = enrichmentStub();
    const processor = new ComprehensiveSummaryProcessor(
      { notifyProgress: vi.fn() } as never,
      {} as never, // chainSummaryService
      {} as never, // contextItemRepository
      {} as never, // consultationRepository
      {} as never, // summaryMetaRepository
      {} as never, // namedEntityRepository
      http as never,
      configStub,
      {} as never, // promptResolutionService
      { assemble: vi.fn().mockResolvedValue(ASSEMBLED) } as never,
      metricsStub,
      clsStub(),
      secretsStub,
      policyStub,
      undefined, // configResolver
      undefined, // usageLedgerService
      undefined, // unitOfWorkService
      undefined, // noteGenerationService
      enrichment as never,
    );

    await (
      processor as never as {
        callTextService(c: unknown, s: unknown, n: unknown, r: unknown, p: unknown, t: string): Promise<unknown>;
      }
    ).callTextService({}, [{ consultationId: 'c-1', type: 'note', content: 'body' }], undefined, {}, null, TENANT);

    expectOverridesPosted(http.axiosRef.post);
  });

  it('ChainSummaryService.callTextService (comprehensive chain)', async () => {
    const http = httpStub();
    const enrichment = enrichmentStub();
    const service = new ChainSummaryService(
      {} as never, // contextItemRepository
      {} as never, // consultationRepository
      {} as never, // summaryMetaRepository
      {} as never, // namedEntityRepository
      http as never,
      configStub,
      { emit: vi.fn() } as never, // eventEmitter
      clsStub(),
      {} as never, // promptAssemblyService
      secretsStub,
      policyStub,
      undefined, // configResolver
      undefined, // usageLedger
      undefined, // unitOfWork
      undefined, // noteGenerationService
      enrichment as never,
    );

    await (service as never as { callTextService(p: unknown): Promise<unknown> }).callTextService({
      assembledPrompt: ASSEMBLED,
      options: {},
      context: {},
    });

    expectOverridesPosted(http.axiosRef.post);
  });

  it('SummaryService.executeTextGenerate (the finalize path a clinician signs)', async () => {
    const http = httpStub();
    const enrichment = enrichmentStub();
    const service = new SummaryService(
      {} as never, // contextItemRepository
      {} as never, // consultationRepository
      {} as never, // summaryMetaRepository
      {} as never, // namedEntityRepository
      http as never,
      configStub,
      { emit: vi.fn() } as never, // eventEmitter
      clsStub(),
      {} as never, // contextItemVersionRepository
      {} as never, // promptAssemblyService
      secretsStub,
      ...(Array.from({ length: 16 }, () => undefined) as never[]), // optional deps 12..27
      enrichment as never,
    );

    await (service as never as { executeTextGenerate(p: unknown, o: unknown): Promise<unknown> }).executeTextGenerate(
      { assembledPrompt: ASSEMBLED, options: { textProvider: PROVIDER, textModel: 'gpt-x' }, context: {} },
      { textProvider: PROVIDER, textModel: 'gpt-x' },
    );

    expectOverridesPosted(http.axiosRef.post);
  });

  it('DnaWritingStyleProcessor.callText', async () => {
    const http = httpStub();
    const enrichment = enrichmentStub();
    const processor = new DnaWritingStyleProcessor(
      {} as never, // jobService
      {} as never, // appSettingsService
      {} as never, // contextItemRepository
      {} as never, // contextItemVersionRepository
      {} as never, // dnaReportRepository
      {} as never, // dnaVersionRepository
      {} as never, // dnaUsageRecordRepository
      {} as never, // promptUsageRecordRepository
      {} as never, // promptManagementService
      http as never,
      configStub,
      metricsStub,
      clsStub(),
      secretsStub,
      policyStub,
      undefined, // configResolver
      undefined, // promptTemplateRepository
      undefined, // phiRedactor
      enrichment as never,
    );

    await (processor as never as { callText(s: string, p: string): Promise<unknown> }).callText('corpus', 'sys');

    expectOverridesPosted(http.axiosRef.post);
  });
});
