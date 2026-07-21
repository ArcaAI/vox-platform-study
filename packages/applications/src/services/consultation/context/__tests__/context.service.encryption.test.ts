/**
 * ContextService — field-encryption wiring.
 *
 * Verifies that the service dual-writes encrypted `content` (via
 * `ContextItemRepository.encryptContentIntoEntity` + the injected
 * SecretsService) on the create/update paths, is best-effort during the soak
 * (never throws into the write path), and never leaks ciphertext columns into
 * the audit SysEvent payload.
 */
import { ContextItemSource, ContextItemType, SysEventType } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the real enums/DTO mapper; override only the domain factories we touch.
vi.mock('@arcaai/domains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/domains')>();
  return {
    ...actual,
    ContextItemFactory: {
      CreateContextItem: vi.fn((init: Record<string, unknown>) => ({
        id: 'ctx-new',
        ...init,
        changes: {} as Record<string, unknown>,
        metaData: undefined,
        markQdrantNeedsSync: vi.fn(),
      })),
      CreateRawSummary: vi.fn((tenantId: string, consultationId: string, content: string) => ({
        id: 'sum-new',
        tenantId,
        consultationId,
        content,
        type: actual.ContextItemType.RAW_SUMMARY,
        changes: {} as Record<string, unknown>,
      })),
    },
    ContextItemVersionFactory: {
      CreateInitialVersion: vi.fn((ci: { id: string; content?: string }, by: string) => ({
        id: 'v1',
        contextItemId: ci.id,
        versionNumber: 1,
        content: ci.content,
        changedBy: by,
      })),
      CreateUserEditVersion: vi.fn((ci: { id: string; content?: string }, n: number) => ({
        id: 'vN',
        contextItemId: ci.id,
        versionNumber: n,
        content: ci.content,
      })),
    },
    SummaryMetaFactory: { CreateWithContext: vi.fn(() => ({ id: 'sm', citationsMap: { c: 1 }, guardrailDecisions: { g: 1 } })) },
    NamedEntityFactory: {
      CreateWithAiModel: vi.fn((_t: string, contextItemId: string, text: string, className: string) => ({
        id: 'ne-1',
        contextItemId,
        text,
        className,
        normalizedText: `${text}-norm`,
        metadata: { source: 'ner' },
        displayText: text,
        isHighConfidence: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      })),
    },
  };
});

import { ContextService } from '../context.service';

const mockContextItemRepository = {
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findWithSummaryMeta: vi.fn(),
  encryptContentIntoEntity: vi.fn(async () => undefined),
};
const mockContextItemVersionRepository = {
  create: vi.fn(),
  getLatestVersionNumber: vi.fn().mockResolvedValue(0),
  encryptFieldsIntoEntity: vi.fn(async () => undefined),
};
const mockAudioRecordingRepository = {};
const mockSummaryMetaRepository = { create: vi.fn(), encryptFieldsIntoEntity: vi.fn(async () => undefined) };
const mockNamedEntityRepository = { create: vi.fn(), encryptFieldsIntoEntity: vi.fn(async () => undefined) };
const mockConsultationRepository = { findById: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockSecretsService = {
  encrypt: vi.fn(async () => 'vault:v1:x'),
  decrypt: vi.fn(),
  getPhiTransitKeyName: () => 'hope-phi',
};

function makeSavedEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ctx-new',
    consultationId: 'consultation-1',
    type: ContextItemType.WORKNOTE,
    source: ContextItemSource.USER,
    content: 'Patient note',
    mediaId: null,
    dnaWritingStyleId: null,
    metaData: undefined,
    currentVersionNumber: 1,
    qdrantSynced: false,
    qdrantSyncedAt: null,
    isSummary: false,
    isFinalSummary: false,
    isPreSummary: false,
    isTranscript: false,
    isCaseNote: false,
    isWorknote: true,
    isNamedEntity: false,
    isAttachment: false,
    isAiGenerated: false,
    requiresContent: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    AudioRecordings: null,
    SummaryMeta: null,
    NamedEntities: null,
    Versions: null,
    ...overrides,
  };
}

function makeService(withSecrets = true): ContextService {
  return new ContextService(
    mockContextItemRepository as any,
    mockContextItemVersionRepository as any,
    mockAudioRecordingRepository as any,
    mockSummaryMetaRepository as any,
    mockNamedEntityRepository as any,
    mockConsultationRepository as any,
    mockEventEmitter as any,
    mockClsService as any,
    withSecrets ? (mockSecretsService as any) : undefined,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockContextItemVersionRepository.getLatestVersionNumber.mockResolvedValue(0);
  mockContextItemRepository.encryptContentIntoEntity.mockResolvedValue(undefined);
  mockContextItemVersionRepository.encryptFieldsIntoEntity.mockResolvedValue(undefined);
  mockSummaryMetaRepository.encryptFieldsIntoEntity.mockResolvedValue(undefined);
  mockNamedEntityRepository.encryptFieldsIntoEntity.mockResolvedValue(undefined);
  mockClsService.get.mockImplementation((key: string) => {
    switch (key) {
      case 'user':
        return { id: 'user-1' };
      case 'tenantId':
        return 'tenant-1';
      default:
        return null;
    }
  });
});

describe('addContext — encrypts content before create (Phase 3B)', () => {
  it('calls encryptContentIntoEntity with the entity + SecretsService BEFORE create', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
    mockContextItemRepository.create.mockResolvedValue(makeSavedEntity());

    const service = makeService(true);
    await service.addContext('consultation-1', { type: ContextItemType.WORKNOTE, content: 'Patient note' });

    expect(mockContextItemRepository.encryptContentIntoEntity).toHaveBeenCalledTimes(1);
    expect(mockContextItemRepository.encryptContentIntoEntity).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Patient note' }),
      mockSecretsService,
    );
    // Ordering: encryption must run before the persist.
    const encOrder = mockContextItemRepository.encryptContentIntoEntity.mock.invocationCallOrder[0];
    const createOrder = mockContextItemRepository.create.mock.invocationCallOrder[0];
    expect(encOrder).toBeLessThan(createOrder);
  });

  it('is best-effort: a SecretsService failure does NOT break the write (soak)', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
    mockContextItemRepository.create.mockResolvedValue(makeSavedEntity());
    mockContextItemRepository.encryptContentIntoEntity.mockRejectedValueOnce(new Error('vault down'));

    const service = makeService(true);
    const result = await service.addContext('consultation-1', { type: ContextItemType.WORKNOTE, content: 'Patient note' });

    expect(result.id).toBe('ctx-new');
    expect(mockContextItemRepository.create).toHaveBeenCalledTimes(1);
  });

  it('skips encryption entirely when no SecretsService is wired (legacy/test construction)', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
    mockContextItemRepository.create.mockResolvedValue(makeSavedEntity());

    const service = makeService(false);
    await service.addContext('consultation-1', { type: ContextItemType.WORKNOTE, content: 'Patient note' });

    expect(mockContextItemRepository.encryptContentIntoEntity).not.toHaveBeenCalled();
    expect(mockContextItemRepository.create).toHaveBeenCalledTimes(1);
  });
});

describe('updateContext — re-encrypts on content change + strips ciphertext from audit (Phase 3B)', () => {
  function existingItem() {
    return {
      id: 'context-item-id-1',
      tenantId: 'tenant-1',
      consultationId: 'consultation-1',
      type: ContextItemType.WORKNOTE,
      content: 'old',
      currentVersionNumber: 1,
      changes: {} as Record<string, unknown>,
      markQdrantNeedsSync: vi.fn(),
      updatedBy: null,
      ...makeSavedEntity({ id: 'context-item-id-1' }),
    };
  }

  it('encrypts when content changes and excludes encryptedContent/contentKeyVersion from the SysEvent', async () => {
    const item = existingItem();
    mockContextItemRepository.findById.mockResolvedValue(item);
    // Simulate the repo helper populating the change-set with ciphertext columns.
    mockContextItemRepository.encryptContentIntoEntity.mockImplementation(async (e: any) => {
      e.changes = { ...e.changes, content: 'new', encryptedContent: Buffer.from('vault:v1:x'), contentKeyVersion: 1 };
    });
    mockContextItemRepository.update.mockResolvedValue(item);

    const service = makeService(true);
    await service.updateContext('context-item-id-1', { content: 'new', changeSummary: 'edit' });

    expect(mockContextItemRepository.encryptContentIntoEntity).toHaveBeenCalledTimes(1);

    const updatedEvent = mockEventEmitter.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceUpdated);
    expect(updatedEvent).toBeDefined();
    const payloadData = (updatedEvent![1] as { data: Record<string, unknown> }).data;
    expect(payloadData).not.toHaveProperty('encryptedContent');
    expect(payloadData).not.toHaveProperty('contentKeyVersion');
    expect(payloadData).toHaveProperty('versionCreated');
  });

  it('does NOT encrypt when content is unchanged (metadata-only update)', async () => {
    const item = existingItem();
    mockContextItemRepository.findById.mockResolvedValue(item);
    mockContextItemRepository.update.mockResolvedValue(item);

    const service = makeService(true);
    await service.updateContext('context-item-id-1', { dnaWritingStyleId: 'style-2' });

    expect(mockContextItemRepository.encryptContentIntoEntity).not.toHaveBeenCalled();
  });
});

describe('ContextItemVersion — encrypts snapshot before create (Phase 3C)', () => {
  it('addContext encrypts the initial version via encryptFieldsIntoEntity BEFORE its create', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
    mockContextItemRepository.create.mockResolvedValue(makeSavedEntity());

    const service = makeService(true);
    await service.addContext('consultation-1', { type: ContextItemType.WORKNOTE, content: 'Patient note' });

    expect(mockContextItemVersionRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
    expect(mockContextItemVersionRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(
      expect.objectContaining({ versionNumber: 1 }),
      mockSecretsService,
    );
    const encOrder = mockContextItemVersionRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0];
    const createOrder = mockContextItemVersionRepository.create.mock.invocationCallOrder[0];
    expect(encOrder).toBeLessThan(createOrder);
  });

  it('is best-effort: a version-encryption failure does NOT break the write', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
    mockContextItemRepository.create.mockResolvedValue(makeSavedEntity());
    mockContextItemVersionRepository.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));

    const service = makeService(true);
    const result = await service.addContext('consultation-1', { type: ContextItemType.WORKNOTE, content: 'Patient note' });

    expect(result.id).toBe('ctx-new');
    expect(mockContextItemVersionRepository.create).toHaveBeenCalledTimes(1);
  });

  it('skips version encryption when no SecretsService is wired', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
    mockContextItemRepository.create.mockResolvedValue(makeSavedEntity());

    const service = makeService(false);
    await service.addContext('consultation-1', { type: ContextItemType.WORKNOTE, content: 'Patient note' });

    expect(mockContextItemVersionRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
    expect(mockContextItemVersionRepository.create).toHaveBeenCalledTimes(1);
  });
});

describe('SummaryMeta — encrypts provenance JSONB before create (Phase 3C)', () => {
  it('addRawSummary encrypts the SummaryMeta via encryptFieldsIntoEntity BEFORE its create', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
    mockContextItemRepository.create.mockResolvedValue(makeSavedEntity({ id: 'sum-new' }));
    mockContextItemRepository.findWithSummaryMeta.mockResolvedValue(makeSavedEntity({ id: 'sum-new' }));

    const service = makeService(true);
    await service.addRawSummary('consultation-1', { content: 'AI generated summary' } as never);

    expect(mockSummaryMetaRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
    expect(mockSummaryMetaRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sm' }),
      mockSecretsService,
    );
    const encOrder = mockSummaryMetaRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0];
    const createOrder = mockSummaryMetaRepository.create.mock.invocationCallOrder[0];
    expect(encOrder).toBeLessThan(createOrder);
  });

  it('is best-effort: a SummaryMeta-encryption failure does NOT break the write', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
    mockContextItemRepository.create.mockResolvedValue(makeSavedEntity({ id: 'sum-new' }));
    mockContextItemRepository.findWithSummaryMeta.mockResolvedValue(makeSavedEntity({ id: 'sum-new' }));
    mockSummaryMetaRepository.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));

    const service = makeService(true);
    await service.addRawSummary('consultation-1', { content: 'AI generated summary' } as never);

    expect(mockSummaryMetaRepository.create).toHaveBeenCalledTimes(1);
  });
});

describe('NamedEntity — encrypts span/metadata before create (Phase 3C)', () => {
  it('addNamedEntities encrypts each entity via encryptFieldsIntoEntity BEFORE its create', async () => {
    mockContextItemRepository.findById.mockResolvedValue({ id: 'context-item-id-1', tenantId: 'tenant-1' });
    mockNamedEntityRepository.create.mockResolvedValue({
      id: 'ne-1',
      text: 'aspirin',
      className: 'DRUG',
      displayText: 'aspirin',
      isHighConfidence: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const service = makeService(true);
    await service.addNamedEntities('context-item-id-1', {
      entities: [{ text: 'aspirin', className: 'DRUG', confidence: 0.9 }],
      aiModelId: 'ner-1',
      aiModelVersion: 'v1',
    } as never);

    expect(mockNamedEntityRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
    expect(mockNamedEntityRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'aspirin', className: 'DRUG' }),
      mockSecretsService,
    );
    const encOrder = mockNamedEntityRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0];
    const createOrder = mockNamedEntityRepository.create.mock.invocationCallOrder[0];
    expect(encOrder).toBeLessThan(createOrder);
  });

  it('skips entity encryption when no SecretsService is wired', async () => {
    mockContextItemRepository.findById.mockResolvedValue({ id: 'context-item-id-1', tenantId: 'tenant-1' });
    mockNamedEntityRepository.create.mockResolvedValue({
      id: 'ne-1',
      text: 'aspirin',
      className: 'DRUG',
      displayText: 'aspirin',
      isHighConfidence: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const service = makeService(false);
    await service.addNamedEntities('context-item-id-1', {
      entities: [{ text: 'aspirin', className: 'DRUG', confidence: 0.9 }],
      aiModelId: 'ner-1',
      aiModelVersion: 'v1',
    } as never);

    expect(mockNamedEntityRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
    expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(1);
  });
});
