/**
 * SummaryService.callTextService — tenant TEXT fallback on finalize
 *
 * `resolveTextFallbackSelection` (`text.finalize.fallback`) was configurable in
 * the admin UI but INERT on the native finalize path — only text-compat ever
 * called it. `callTextService` now mirrors compat's provider-failure fallback
 * (`text-compat.controller.ts#computeSummary`): on a provider-side failure,
 * retry EXACTLY ONCE against the tenant's configured fallback selection;
 * propagate the ORIGINAL error when no fallback is configured, the fallback
 * is the same provider as the primary, or the fallback attempt also fails.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SummaryService } from '../summary.service';

const createMockClsService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'tenantId') return 'tenant-1';
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
  findById: vi.fn().mockResolvedValue({ id: 'c-1', tenantId: 'tenant-1' }),
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

describe('SummaryService.callTextService — tenant TEXT fallback (B-03)', () => {
  let mockContextItemRepository: ReturnType<typeof createMockContextItemRepository>;
  let mockHttpService: { axiosRef: { post: ReturnType<typeof vi.fn> } };
  let mockHarnessPolicyService: {
    resolveTextSelection: ReturnType<typeof vi.fn>;
    resolveTextFallbackSelection: ReturnType<typeof vi.fn>;
  };
  let service: SummaryService;

  const providerSideError = () => {
    const err = new Error('TEXT provider error') as Error & { response?: unknown };
    err.response = { status: 502, data: { detail: 'upstream LLM failure' } };
    return err;
  };

  const connectPhaseError = () => {
    const err = new Error('connect ECONNREFUSED') as Error & { code?: string };
    err.code = 'ECONNREFUSED';
    return err;
  };

  const buildService = () => {
    mockContextItemRepository = createMockContextItemRepository();
    mockHttpService = { axiosRef: { post: vi.fn() } };
    mockHarnessPolicyService = {
      resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'primary-provider', model: 'primary-model' }),
      resolveTextFallbackSelection: vi.fn().mockResolvedValue(null),
    };

    return new SummaryService(
      mockContextItemRepository as any,
      createMockConsultationRepository() as any,
      createMockSummaryMetaRepository() as any,
      createMockNamedEntityRepository() as any,
      mockHttpService as any,
      createMockConfigService() as any,
      createMockEventEmitter() as any,
      createMockClsService() as any,
      createMockContextItemVersionRepository() as any,
      createMockPromptAssemblyService() as any,
      { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') } as any, // secretsService
      undefined, // userProfileRepository
      undefined, // harnessAuditService
      undefined, // harnessGatewayService
      mockHarnessPolicyService as any,
    );
  };

  const lastPostBody = () => {
    const call = mockHttpService.axiosRef.post.mock.calls.at(-1)!;
    return call[1] as { provider?: string; model?: string };
  };

  beforeEach(() => {
    service = buildService();
  });

  it('retries EXACTLY ONCE against the tenant fallback selection on a provider-side failure', async () => {
    mockHttpService.axiosRef.post.mockRejectedValueOnce(providerSideError()).mockResolvedValueOnce({
      data: { summary: 'S (fallback)', modelName: 'fallback-model' },
    });
    mockHarnessPolicyService.resolveTextFallbackSelection.mockResolvedValue({ provider: 'fallback-provider', model: 'fallback-model' });

    await service.generateSummary('c-1', {} as any);

    expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(2);
    expect(mockHarnessPolicyService.resolveTextFallbackSelection).toHaveBeenCalledWith('tenant-1', 'finalize');
    expect(lastPostBody().provider).toBe('fallback-provider');
    expect(lastPostBody().model).toBe('fallback-model');
  });

  it('propagates the ORIGINAL error (BadRequestException) when no fallback is configured', async () => {
    mockHttpService.axiosRef.post.mockRejectedValue(providerSideError());
    mockHarnessPolicyService.resolveTextFallbackSelection.mockResolvedValue(null);

    await expect(service.generateSummary('c-1', {} as any)).rejects.toThrow(/TEXT provider error/);

    expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1); // no retry attempted
  });

  it('does not retry when the fallback resolves to the SAME provider as the primary', async () => {
    mockHttpService.axiosRef.post.mockRejectedValue(providerSideError());
    mockHarnessPolicyService.resolveTextFallbackSelection.mockResolvedValue({ provider: 'primary-provider', model: 'primary-model' });

    await expect(service.generateSummary('c-1', {} as any)).rejects.toThrow();

    expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
  });

  it('is NOT eligible for a connect-phase failure (unreachable TEXT) — no fallback attempted', async () => {
    mockHttpService.axiosRef.post.mockRejectedValue(connectPhaseError());
    mockHarnessPolicyService.resolveTextFallbackSelection.mockResolvedValue({ provider: 'fallback-provider', model: 'fallback-model' });

    await expect(service.generateSummary('c-1', {} as any)).rejects.toThrow();

    expect(mockHarnessPolicyService.resolveTextFallbackSelection).not.toHaveBeenCalled();
    expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
  });

  it('surfaces the ORIGINAL primary error when the fallback attempt ALSO fails', async () => {
    mockHttpService.axiosRef.post.mockRejectedValueOnce(providerSideError()).mockRejectedValueOnce(new Error('fallback provider also down'));
    mockHarnessPolicyService.resolveTextFallbackSelection.mockResolvedValue({ provider: 'fallback-provider', model: 'fallback-model' });

    await expect(service.generateSummary('c-1', {} as any)).rejects.toThrow(/TEXT provider error/);

    expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(2);
  });

  it('resolves the primary selection with the CLS tenant + finalize task explicitly', async () => {
    mockHttpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });

    await service.generateSummary('c-1', {} as any);

    expect(mockHarnessPolicyService.resolveTextSelection).toHaveBeenCalledWith('tenant-1', 'finalize');
  });
});
