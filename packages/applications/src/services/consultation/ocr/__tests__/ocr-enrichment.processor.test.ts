/**
 * OcrEnrichmentProcessor unit tests — orchestration.
 *
 * Event-driven: reacts to `ConsultationPipelineEvent.ContextAdded`. When an
 * ATTACHMENT has a `mediaId` but no `metaData.extractedText`, it fetches the file
 * bytes (IBlobStorageService.getObject — mocked), calls the NLP `/extract`
 * endpoint (HttpService — mocked), persists `metaData.extractedText`, and
 * re-emits the live `ContextAdded` preview. A loop guard makes the re-fire a
 * no-op (extractedText now present). Failures degrade gracefully (never throw).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OcrEnrichmentProcessor } from '../ocr-enrichment.processor';

const CONTEXT_ADDED = 'consultation.context.added';

const createMockBlobStorage = () => ({ getObject: vi.fn() });
const createMockContextItemRepository = () => ({
  findById: vi.fn(),
  update: vi.fn(),
  encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
});
const createMockHttpService = () => ({ axiosRef: { post: vi.fn() } });
const createMockEventEmitter = () => ({ emit: vi.fn() });

const createMockConfigService = (overrides: Record<string, string | undefined> = {}) => ({
  get: vi.fn().mockImplementation((key: string) => {
    const values: Record<string, string | undefined> = {
      NLP_URL: 'http://localhost:8864',
      ...overrides,
    };
    return values[key];
  }),
});

// ClsService mock — run() invokes the callback synchronously (mirrors ner.processor.test.ts).
const createMockClsService = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((...args: unknown[]) => {
      const callback = (args.length === 1 ? args[0] : args[1]) as () => unknown;
      return callback();
    }),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
    }),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
    has: vi.fn((key: string) => store.has(key)),
    isActive: vi.fn(() => true),
  };
};

const createMockAttachment = (overrides: Record<string, unknown> = {}) => ({
  id: 'ctx-att-1',
  consultationId: 'consultation-1',
  type: 'ATTACHMENT',
  tenantId: 'tenant-1',
  mediaId: 'attachments/lab-scan.pdf',
  content: 'Lab/exam result: scan.pdf',
  metaData: { subType: 'LAB_RESULT', fileName: 'scan.pdf' },
  ...overrides,
});

const createPayload = (overrides: Record<string, unknown> = {}) => ({
  consultationId: 'consultation-1',
  tenantId: 'tenant-1',
  userId: 'doctor-1',
  timestamp: new Date().toISOString(),
  contextItemId: 'ctx-att-1',
  contextType: 'ATTACHMENT',
  subType: 'LAB_RESULT',
  contentPreview: 'Lab/exam result: scan.pdf',
  ...overrides,
});

describe('OcrEnrichmentProcessor', () => {
  let processor: OcrEnrichmentProcessor;
  let blobStorage: ReturnType<typeof createMockBlobStorage>;
  let contextItemRepository: ReturnType<typeof createMockContextItemRepository>;
  let httpService: ReturnType<typeof createMockHttpService>;
  let configService: ReturnType<typeof createMockConfigService>;
  let eventEmitter: ReturnType<typeof createMockEventEmitter>;
  let cls: ReturnType<typeof createMockClsService>;

  const build = (config = createMockConfigService(), secretsService?: unknown) => {
    configService = config;
    return new OcrEnrichmentProcessor(
      blobStorage as never,
      contextItemRepository as never,
      httpService as never,
      configService as never,
      eventEmitter as never,
      cls as never,
      secretsService as never,
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    blobStorage = createMockBlobStorage();
    contextItemRepository = createMockContextItemRepository();
    httpService = createMockHttpService();
    eventEmitter = createMockEventEmitter();
    cls = createMockClsService();
    processor = build();
  });

  it('enriches an ATTACHMENT with no extractedText: fetch → OCR → persist → re-emit', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    blobStorage.getObject.mockResolvedValue(Buffer.from('%PDF-1.7 scanned bytes'));
    httpService.axiosRef.post.mockResolvedValue({ data: { text: 'WBC 11.2 (high); Hb 9.8', pageCount: 2, ocrUsed: true } });
    contextItemRepository.update.mockImplementation((_id: string, entity: unknown) => entity);

    await processor.handleContextAdded(createPayload());

    // (1) fetched the bytes from the attachments bucket using mediaId as the key
    expect(blobStorage.getObject).toHaveBeenCalledWith({ bucket: 'attachments', key: 'attachments/lab-scan.pdf' });

    // (2) called the NLP /extract endpoint
    expect(httpService.axiosRef.post).toHaveBeenCalledTimes(1);
    expect(httpService.axiosRef.post.mock.calls[0][0]).toBe('http://localhost:8864/api/v1/extract');

    // (3) persisted metaData.extractedText, preserving prior metadata
    expect(contextItemRepository.update).toHaveBeenCalledTimes(1);
    const [updatedId, updatedEntity] = contextItemRepository.update.mock.calls[0];
    expect(updatedId).toBe('ctx-att-1');
    expect((updatedEntity as { metaData: Record<string, unknown> }).metaData).toMatchObject({
      subType: 'LAB_RESULT',
      fileName: 'scan.pdf',
      extractedText: 'WBC 11.2 (high); Hb 9.8',
    });

    // (4) re-emitted the live ContextAdded preview with the OCR text
    const reEmit = eventEmitter.emit.mock.calls.find((c) => c[0] === CONTEXT_ADDED);
    expect(reEmit).toBeDefined();
    expect(reEmit![1]).toMatchObject({
      contextItemId: 'ctx-att-1',
      contextType: 'ATTACHMENT',
      subType: 'LAB_RESULT',
      contentPreview: 'WBC 11.2 (high); Hb 9.8',
    });
  });

  it('LOOP GUARD: no-op when extractedText is already present (re-fire is a no-op)', async () => {
    contextItemRepository.findById.mockResolvedValue(
      createMockAttachment({ metaData: { subType: 'LAB_RESULT', fileName: 'scan.pdf', extractedText: 'already extracted' } }),
    );

    await processor.handleContextAdded(createPayload());

    expect(blobStorage.getObject).not.toHaveBeenCalled();
    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
    expect(contextItemRepository.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('ignores non-ATTACHMENT context types (no DB read)', async () => {
    await processor.handleContextAdded(createPayload({ contextType: 'WORKNOTE' }));

    expect(contextItemRepository.findById).not.toHaveBeenCalled();
    expect(blobStorage.getObject).not.toHaveBeenCalled();
    expect(contextItemRepository.update).not.toHaveBeenCalled();
  });

  it('no-ops for an ATTACHMENT without a mediaId (nothing to OCR)', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment({ mediaId: null }));

    await processor.handleContextAdded(createPayload());

    expect(blobStorage.getObject).not.toHaveBeenCalled();
    expect(contextItemRepository.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('does not persist or re-emit when OCR yields empty text (graceful label fallback)', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    blobStorage.getObject.mockResolvedValue(Buffer.from('image-only'));
    httpService.axiosRef.post.mockResolvedValue({ data: { text: '', pageCount: 1, ocrUsed: true } });

    await processor.handleContextAdded(createPayload());

    expect(contextItemRepository.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('is fully gated off when OCR_ENABLED=false', async () => {
    processor = build(createMockConfigService({ OCR_ENABLED: 'false' }));

    await processor.handleContextAdded(createPayload());

    expect(contextItemRepository.findById).not.toHaveBeenCalled();
    expect(blobStorage.getObject).not.toHaveBeenCalled();
  });

  it('uses a configurable OCR storage bucket', async () => {
    processor = build(createMockConfigService({ OCR_STORAGE_BUCKET: 'tenant-uploads' }));
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    blobStorage.getObject.mockResolvedValue(Buffer.from('bytes'));
    httpService.axiosRef.post.mockResolvedValue({ data: { text: 'ok', pageCount: 1, ocrUsed: false } });
    contextItemRepository.update.mockImplementation((_id: string, entity: unknown) => entity);

    await processor.handleContextAdded(createPayload());

    expect(blobStorage.getObject).toHaveBeenCalledWith({ bucket: 'tenant-uploads', key: 'attachments/lab-scan.pdf' });
  });

  it('never throws and does not persist when blob fetch fails', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    blobStorage.getObject.mockRejectedValue(new Error('S3 down'));

    await expect(processor.handleContextAdded(createPayload())).resolves.toBeUndefined();

    expect(contextItemRepository.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('never throws and does not persist when the NLP call fails', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    blobStorage.getObject.mockResolvedValue(Buffer.from('bytes'));
    httpService.axiosRef.post.mockRejectedValue(new Error('NLP unreachable'));

    await expect(processor.handleContextAdded(createPayload())).resolves.toBeUndefined();

    expect(contextItemRepository.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('re-establishes CLS (tenantId) for the @OnEvent microtask', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    blobStorage.getObject.mockResolvedValue(Buffer.from('bytes'));
    httpService.axiosRef.post.mockResolvedValue({ data: { text: 'ok', pageCount: 1, ocrUsed: false } });
    contextItemRepository.update.mockImplementation((_id: string, entity: unknown) => entity);

    await processor.handleContextAdded(createPayload());

    expect(cls.run).toHaveBeenCalledTimes(1);
    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
  });

  it('fail-closed: no-op when payload tenantId is missing', async () => {
    await processor.handleContextAdded(createPayload({ tenantId: undefined }));

    expect(cls.run).not.toHaveBeenCalled();
    expect(contextItemRepository.findById).not.toHaveBeenCalled();
  });

  it('does not persist on a cross-tenant context item (defense in depth)', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment({ tenantId: 'tenant-OTHER' }));
    blobStorage.getObject.mockResolvedValue(Buffer.from('bytes'));

    await expect(processor.handleContextAdded(createPayload({ tenantId: 'tenant-1' }))).resolves.toBeUndefined();

    expect(contextItemRepository.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  // ── F-031 remainder: OCR-extracted text must also land on the entity's
  // canonical `content` (encrypted before persist), not ONLY on the unencrypted
  // `metaData.extractedText` — otherwise every reader of the standard
  // ContextItem response (`content`) sees nothing even after a successful OCR,
  // and the plaintext `content` column was dropped, so an unencrypted write
  // would silently lose the text at rest in every environment.
  describe('OCR content encryption-at-rest (F-031)', () => {
    const secretsStub = { encrypt: vi.fn(), decrypt: vi.fn() };

    it('sets ContextItem.content from the OCR text and encrypts it before persisting', async () => {
      processor = build(createMockConfigService(), secretsStub);
      contextItemRepository.findById.mockResolvedValue(createMockAttachment({ content: undefined }));
      blobStorage.getObject.mockResolvedValue(Buffer.from('%PDF-1.7 scanned bytes'));
      httpService.axiosRef.post.mockResolvedValue({ data: { text: 'WBC 11.2 (high); Hb 9.8', pageCount: 2, ocrUsed: true } });
      contextItemRepository.update.mockImplementation((_id: string, entity: unknown) => entity);

      await processor.handleContextAdded(createPayload());

      expect(contextItemRepository.encryptContentIntoEntity).toHaveBeenCalledTimes(1);
      const [entityArg, secretsArg] = contextItemRepository.encryptContentIntoEntity.mock.calls[0];
      expect(entityArg.content).toBe('WBC 11.2 (high); Hb 9.8');
      expect(secretsArg).toBe(secretsStub);
      const encOrder = contextItemRepository.encryptContentIntoEntity.mock.invocationCallOrder[0];
      const updateOrder = contextItemRepository.update.mock.invocationCallOrder[0];
      expect(encOrder).toBeLessThan(updateOrder);
      expect(contextItemRepository.update.mock.calls[0][1]).toBe(entityArg);
    });

    it('still persists (without ciphertext) when no SecretsService is wired', async () => {
      contextItemRepository.findById.mockResolvedValue(createMockAttachment({ content: undefined }));
      blobStorage.getObject.mockResolvedValue(Buffer.from('bytes'));
      httpService.axiosRef.post.mockResolvedValue({ data: { text: 'No cipher wired', pageCount: 1, ocrUsed: true } });
      contextItemRepository.update.mockImplementation((_id: string, entity: unknown) => entity);

      await processor.handleContextAdded(createPayload());

      expect(contextItemRepository.encryptContentIntoEntity).not.toHaveBeenCalled();
      expect(contextItemRepository.update.mock.calls[0][1]).toMatchObject({ content: 'No cipher wired' });
    });
  });
});
