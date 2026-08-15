/**
 * SummaryService — warm-start pre-summary decrypt + subType fix
 *
 * B-02: `generateSummary` used to read `latestPreSummary?.content` off the
 * plain (non-decrypting) `findLatestPreSummary` finder — empty text in
 * Vault-backed envs, since the plaintext `content` column was dropped and
 * only `encryptedContent` is persisted.
 *
 * B-06: the finder was not subType-aware, so a case-notes PRE_SUMMARY created
 * after a LIVE_SOAP_SNAPSHOT would shadow it in the warm-start read.
 *
 * `generateSummary` now goes through
 * `ContextItemRepository.findLatestPreSummaryWithDecryptedContent`, preferring
 * a LIVE_SOAP_SNAPSHOT and falling back to the legacy "latest pre-summary of
 * any kind" behavior when no snapshot exists.
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

const createMockHttpService = () => ({
  axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'S', modelName: 'm' } }) },
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

describe('SummaryService.generateSummary — warm-start pre-summary (B-02/B-06)', () => {
  let mockContextItemRepository: ReturnType<typeof createMockContextItemRepository>;
  let mockSecretsService: { encrypt: ReturnType<typeof vi.fn>; decrypt: ReturnType<typeof vi.fn>; getSecretOptional: ReturnType<typeof vi.fn> };
  let service: SummaryService;
  let mockPromptAssemblyService: ReturnType<typeof createMockPromptAssemblyService>;

  beforeEach(() => {
    mockContextItemRepository = createMockContextItemRepository();
    mockSecretsService = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') };
    mockPromptAssemblyService = createMockPromptAssemblyService();

    service = new SummaryService(
      mockContextItemRepository as any,
      createMockConsultationRepository() as any,
      createMockSummaryMetaRepository() as any,
      createMockNamedEntityRepository() as any,
      createMockHttpService() as any,
      createMockConfigService() as any,
      createMockEventEmitter() as any,
      createMockClsService() as any,
      createMockContextItemVersionRepository() as any,
      mockPromptAssemblyService as any,
      mockSecretsService as any, // secretsService
    );
  });

  it('populates preSummaryText from the decrypted LIVE_SOAP_SNAPSHOT (B-02)', async () => {
    mockContextItemRepository.findLatestPreSummaryWithDecryptedContent.mockImplementation(
      async (_consultationId: string, _secrets: unknown, options?: { subType?: string }) => {
        if (options?.subType === 'LIVE_SOAP_SNAPSHOT') {
          return { entity: { id: 'ctx-snapshot' }, plaintext: 'S: decrypted live snapshot text' };
        }
        return { entity: null, plaintext: null };
      },
    );

    await service.generateSummary('c-1', {} as any);

    expect(mockContextItemRepository.findLatestPreSummaryWithDecryptedContent).toHaveBeenCalledWith('c-1', mockSecretsService, {
      subType: 'LIVE_SOAP_SNAPSHOT',
    });
    expect(mockPromptAssemblyService.assemble).toHaveBeenCalledWith(
      expect.objectContaining({ preSummaryText: 'S: decrypted live snapshot text' }),
    );
  });

  it('prefers the snapshot over a newer case-notes pre-summary (B-06 — no shadowing)', async () => {
    mockContextItemRepository.findLatestPreSummaryWithDecryptedContent.mockImplementation(
      async (_consultationId: string, _secrets: unknown, options?: { subType?: string }) => {
        if (options?.subType === 'LIVE_SOAP_SNAPSHOT') {
          return { entity: { id: 'ctx-snapshot' }, plaintext: 'live snapshot text' };
        }
        // Legacy unfiltered lookup would return the NEWER case-notes row —
        // must never win when a snapshot exists.
        return { entity: { id: 'ctx-casenote' }, plaintext: 'newer case note text' };
      },
    );

    await service.generateSummary('c-1', {} as any);

    expect(mockPromptAssemblyService.assemble).toHaveBeenCalledWith(expect.objectContaining({ preSummaryText: 'live snapshot text' }));
  });

  it('falls back to the legacy (any-subtype) pre-summary when no snapshot exists', async () => {
    mockContextItemRepository.findLatestPreSummaryWithDecryptedContent.mockImplementation(
      async (_consultationId: string, _secrets: unknown, options?: { subType?: string }) => {
        if (options?.subType === 'LIVE_SOAP_SNAPSHOT') return { entity: null, plaintext: null };
        return { entity: { id: 'ctx-casenote' }, plaintext: 'decrypted case note text' };
      },
    );

    await service.generateSummary('c-1', {} as any);

    expect(mockContextItemRepository.findLatestPreSummaryWithDecryptedContent).toHaveBeenCalledWith('c-1', mockSecretsService);
    expect(mockPromptAssemblyService.assemble).toHaveBeenCalledWith(expect.objectContaining({ preSummaryText: 'decrypted case note text' }));
  });

  it('leaves preSummaryText undefined when there is no pre-summary of any kind', async () => {
    await service.generateSummary('c-1', {} as any);

    expect(mockPromptAssemblyService.assemble).toHaveBeenCalledWith(expect.objectContaining({ preSummaryText: undefined }));
  });

  // `resolveWarmStartPreSummary` already delegates entirely to
  // `findLatestPreSummaryWithDecryptedContent` (no hand-rolled copy here, so
  // no production change was needed for this call site). This pins that a
  // decrypt failure propagates out of `generateSummary()` rather than being
  // silently swallowed — `generateSummary` has no try/catch around the
  // warm-start read.
  it('propagates a decryption failure rather than swallowing it', async () => {
    mockContextItemRepository.findLatestPreSummaryWithDecryptedContent.mockRejectedValue(new Error('vault transit unavailable'));

    await expect(service.generateSummary('c-1', {} as any)).rejects.toThrow('vault transit unavailable');
  });
});
