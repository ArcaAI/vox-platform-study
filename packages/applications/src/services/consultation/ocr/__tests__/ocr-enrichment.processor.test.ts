/**
 * OcrEnrichmentProcessor unit tests — orchestration.
 *
 * Event-driven: reacts to `ConsultationPipelineEvent.ContextAdded`. When an
 * ATTACHMENT has a `mediaId` but no `metaData.extractedText`, it resolves
 * `mediaId` (a `Media` row UUID) via `MediaRepository.findById` →
 * `parseStorageUri(media.uri)` to the ACTUAL bucket/key (TASK-656 — `mediaId`
 * is never a literal S3 key), fetches the file bytes (IBlobStorageService.getObject
 * — mocked), calls the NLP `/extract` endpoint (HttpService — mocked), persists
 * `metaData.extractedText`, and re-emits the live `ContextAdded` preview. A loop
 * guard makes the re-fire a no-op (extractedText now present). Failures degrade
 * gracefully (never throw).
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
const createMockMediaRepository = () => ({ findById: vi.fn() });
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

// mediaId is a Media row UUID (TASK-656) — NEVER a literal S3 key.
const MEDIA_ID = 'media-uuid-1';

const createMockAttachment = (overrides: Record<string, unknown> = {}) => ({
  id: 'ctx-att-1',
  consultationId: 'consultation-1',
  type: 'ATTACHMENT',
  tenantId: 'tenant-1',
  mediaId: MEDIA_ID,
  content: 'Lab/exam result: scan.pdf',
  metaData: { subType: 'LAB_RESULT', fileName: 'scan.pdf' },
  ...overrides,
});

/** The `Media` row `mediaId` resolves to — `uri` written by StorageController on upload. */
const createMockMediaRow = (overrides: Record<string, unknown> = {}) => ({
  id: MEDIA_ID,
  uri: 's3://attachments/lab-scan.pdf',
  mimeType: 'application/pdf',
  name: 'scan.pdf',
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
  let mediaRepository: ReturnType<typeof createMockMediaRepository>;
  let httpService: ReturnType<typeof createMockHttpService>;
  let configService: ReturnType<typeof createMockConfigService>;
  let eventEmitter: ReturnType<typeof createMockEventEmitter>;
  let cls: ReturnType<typeof createMockClsService>;

  const build = (config = createMockConfigService(), secretsService?: unknown, media: unknown = mediaRepository) => {
    configService = config;
    return new OcrEnrichmentProcessor(
      blobStorage as never,
      contextItemRepository as never,
      httpService as never,
      configService as never,
      eventEmitter as never,
      cls as never,
      secretsService as never,
      media as never,
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    blobStorage = createMockBlobStorage();
    contextItemRepository = createMockContextItemRepository();
    mediaRepository = createMockMediaRepository();
    httpService = createMockHttpService();
    eventEmitter = createMockEventEmitter();
    cls = createMockClsService();
    processor = build();
  });

  it('enriches an ATTACHMENT with no extractedText: resolve Media → fetch → OCR → persist → re-emit', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    mediaRepository.findById.mockResolvedValue(createMockMediaRow());
    blobStorage.getObject.mockResolvedValue(Buffer.from('%PDF-1.7 scanned bytes'));
    httpService.axiosRef.post.mockResolvedValue({ data: { text: 'WBC 11.2 (high); Hb 9.8', pageCount: 2, ocrUsed: true } });
    contextItemRepository.update.mockImplementation((_id: string, entity: unknown) => entity);

    await processor.handleContextAdded(createPayload());

    // (0) resolved the Media row by mediaId (the UUID, never treated as a literal key)
    expect(mediaRepository.findById).toHaveBeenCalledWith(MEDIA_ID);

    // (1) fetched the bytes using the bucket/key DECODED from the Media row's uri —
    // NOT `{ bucket: 'attachments', key: mediaId }` (the pre-TASK-656 bug: mediaId
    // treated as the literal S3 key).
    expect(blobStorage.getObject).toHaveBeenCalledWith({ bucket: 'attachments', key: 'lab-scan.pdf' });
    expect(blobStorage.getObject).not.toHaveBeenCalledWith({ bucket: 'attachments', key: MEDIA_ID });

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

  it('resolves the bucket ENCODED IN the Media row uri, not a fixed default', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    mediaRepository.findById.mockResolvedValue(createMockMediaRow({ uri: 's3://tenant-uploads/nested/path/scan.pdf' }));
    blobStorage.getObject.mockResolvedValue(Buffer.from('bytes'));
    httpService.axiosRef.post.mockResolvedValue({ data: { text: 'ok', pageCount: 1, ocrUsed: false } });
    contextItemRepository.update.mockImplementation((_id: string, entity: unknown) => entity);

    await processor.handleContextAdded(createPayload());

    expect(blobStorage.getObject).toHaveBeenCalledWith({ bucket: 'tenant-uploads', key: 'nested/path/scan.pdf' });
  });

  it('no-ops (never fetches bytes) when the Media row is not found', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    mediaRepository.findById.mockRejectedValue(new Error('not found')); // mirrors Repository.findById → DataNotFoundException

    await expect(processor.handleContextAdded(createPayload())).resolves.toBeUndefined();

    expect(blobStorage.getObject).not.toHaveBeenCalled();
    expect(contextItemRepository.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('no-ops when the Media row uri is unparseable (not an s3:// uri)', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    mediaRepository.findById.mockResolvedValue(createMockMediaRow({ uri: 'not-a-storage-uri' }));

    await expect(processor.handleContextAdded(createPayload())).resolves.toBeUndefined();

    expect(blobStorage.getObject).not.toHaveBeenCalled();
    expect(contextItemRepository.update).not.toHaveBeenCalled();
  });

  it('degrades to a no-op when MediaRepository is not wired (optional dependency absent)', async () => {
    processor = build(createMockConfigService(), undefined, undefined);
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());

    await expect(processor.handleContextAdded(createPayload())).resolves.toBeUndefined();

    expect(blobStorage.getObject).not.toHaveBeenCalled();
    expect(contextItemRepository.update).not.toHaveBeenCalled();
  });

  it('LOOP GUARD: no-op when extractedText is already present (re-fire is a no-op)', async () => {
    contextItemRepository.findById.mockResolvedValue(
      createMockAttachment({ metaData: { subType: 'LAB_RESULT', fileName: 'scan.pdf', extractedText: 'already extracted' } }),
    );

    await processor.handleContextAdded(createPayload());

    expect(mediaRepository.findById).not.toHaveBeenCalled();
    expect(blobStorage.getObject).not.toHaveBeenCalled();
    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
    expect(contextItemRepository.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('ignores non-ATTACHMENT context types (no DB read)', async () => {
    await processor.handleContextAdded(createPayload({ contextType: 'WORKNOTE' }));

    expect(contextItemRepository.findById).not.toHaveBeenCalled();
    expect(mediaRepository.findById).not.toHaveBeenCalled();
    expect(blobStorage.getObject).not.toHaveBeenCalled();
    expect(contextItemRepository.update).not.toHaveBeenCalled();
  });

  it('no-ops for an ATTACHMENT without a mediaId (nothing to OCR)', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment({ mediaId: null }));

    await processor.handleContextAdded(createPayload());

    expect(mediaRepository.findById).not.toHaveBeenCalled();
    expect(blobStorage.getObject).not.toHaveBeenCalled();
    expect(contextItemRepository.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('does not persist or re-emit when OCR yields empty text (graceful label fallback)', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    mediaRepository.findById.mockResolvedValue(createMockMediaRow());
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
    expect(mediaRepository.findById).not.toHaveBeenCalled();
    expect(blobStorage.getObject).not.toHaveBeenCalled();
  });

  it('never throws and does not persist when blob fetch fails', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    mediaRepository.findById.mockResolvedValue(createMockMediaRow());
    blobStorage.getObject.mockRejectedValue(new Error('S3 down'));

    await expect(processor.handleContextAdded(createPayload())).resolves.toBeUndefined();

    expect(contextItemRepository.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('never throws and does not persist when the NLP call fails', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    mediaRepository.findById.mockResolvedValue(createMockMediaRow());
    blobStorage.getObject.mockResolvedValue(Buffer.from('bytes'));
    httpService.axiosRef.post.mockRejectedValue(new Error('NLP unreachable'));

    await expect(processor.handleContextAdded(createPayload())).resolves.toBeUndefined();

    expect(contextItemRepository.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('re-establishes CLS (tenantId) for the @OnEvent microtask', async () => {
    contextItemRepository.findById.mockResolvedValue(createMockAttachment());
    mediaRepository.findById.mockResolvedValue(createMockMediaRow());
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

    await expect(processor.handleContextAdded(createPayload({ tenantId: 'tenant-1' }))).resolves.toBeUndefined();

    expect(mediaRepository.findById).not.toHaveBeenCalled();
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
      mediaRepository.findById.mockResolvedValue(createMockMediaRow());
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
      mediaRepository.findById.mockResolvedValue(createMockMediaRow());
      blobStorage.getObject.mockResolvedValue(Buffer.from('bytes'));
      httpService.axiosRef.post.mockResolvedValue({ data: { text: 'No cipher wired', pageCount: 1, ocrUsed: true } });
      contextItemRepository.update.mockImplementation((_id: string, entity: unknown) => entity);

      await processor.handleContextAdded(createPayload());

      expect(contextItemRepository.encryptContentIntoEntity).not.toHaveBeenCalled();
      expect(contextItemRepository.update.mock.calls[0][1]).toMatchObject({ content: 'No cipher wired' });
    });
  });
});
