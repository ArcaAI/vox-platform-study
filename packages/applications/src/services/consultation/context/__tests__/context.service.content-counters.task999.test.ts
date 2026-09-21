/**
 * TASK-999 (D-3(a)) — `ContextItem` carries its own plaintext size, measured by the WRITER.
 *
 * ============================================================================
 * WHY THE WRITER AND NOT THE READER
 * ============================================================================
 * A context item's clinical body lives only as Vault-Transit ciphertext. The consultation
 * telemetry pane needs case-note and transcript VOLUME on an ADMIN read, and the only way to
 * measure ciphertext is to decrypt it — which would push PHI through a reporting path to
 * produce two integers. So it is counted once, here, from the plaintext this service is already
 * holding on its way into `encryptContent`.
 *
 * NULL means NEVER MEASURED (every row written before this ticket, and a media item with no
 * body at all). `0` is a real empty body. The distinction is the whole point: a pane that
 * cannot tell them apart renders a confident "0 words" for every historical consultation.
 */
import { ContextItemSource, ContextItemType } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the real enums/DTO mapper; override only the domain factories we touch, so the props the
// service hands the factory are observable on the entity it gets back.
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
      CreateInitialVersion: vi.fn((ci: { id: string }) => ({ id: 'v1', contextItemId: ci.id, versionNumber: 1 })),
      CreateUserEditVersion: vi.fn((ci: { id: string }, n: number) => ({ id: 'vN', contextItemId: ci.id, versionNumber: n })),
    },
  };
});

import { ContextService } from '../context.service';

const mockContextItemRepository = {
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn((id: string, entity: unknown) => mockContextItemRepository.update(id, entity)),
  findWithSummaryMeta: vi.fn(),
  encryptContentIntoEntity: vi.fn(async () => undefined),
};
const mockContextItemVersionRepository = {
  create: vi.fn(),
  getLatestVersionNumber: vi.fn().mockResolvedValue(0),
  encryptFieldsIntoEntity: vi.fn(async () => undefined),
};
const mockConsultationRepository = { findById: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockSecretsService = { encrypt: vi.fn(async () => 'vault:v1:x'), decrypt: vi.fn(), getPhiTransitKeyName: () => 'hope-phi' };

function savedEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ctx-new',
    consultationId: 'consultation-1',
    type: ContextItemType.CASE_NOTE,
    source: ContextItemSource.USER,
    content: 'Patient reports a dry cough.',
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
    isCaseNote: true,
    isWorknote: false,
    isNamedEntity: false,
    isAttachment: false,
    isAiGenerated: false,
    requiresContent: true,
    createdAt: new Date('2026-09-22T00:00:00Z'),
    updatedAt: new Date('2026-09-22T00:00:00Z'),
    AudioRecordings: null,
    SummaryMeta: null,
    NamedEntities: null,
    Versions: null,
    ...overrides,
  };
}

function makeService(): ContextService {
  return new ContextService(
    mockContextItemRepository as never,
    mockContextItemVersionRepository as never,
    {} as never, // audioRecordingRepository
    { create: vi.fn(), encryptFieldsIntoEntity: vi.fn(async () => undefined) } as never,
    { create: vi.fn(), encryptFieldsIntoEntity: vi.fn(async () => undefined) } as never,
    mockConsultationRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockSecretsService as never,
  );
}

/** What the service handed the factory — the counters ride the create props. */
const createdEntity = () => mockContextItemRepository.create.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mockContextItemVersionRepository.getLatestVersionNumber.mockResolvedValue(0);
  mockContextItemRepository.encryptContentIntoEntity.mockResolvedValue(undefined);
  mockContextItemVersionRepository.encryptFieldsIntoEntity.mockResolvedValue(undefined);
  mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
  mockContextItemRepository.create.mockResolvedValue(savedEntity());
  mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'user-1' } : key === 'tenantId' ? 'tenant-1' : null));
});

describe('addContext — the writer measures the body (TASK-999 D-3(a))', () => {
  it('persists a CASE_NOTE’s word and character counts', async () => {
    // RED before the change: the columns did not exist and nothing counted anything, so the
    // telemetry pane had no case-note volume for any consultation, ever.
    await makeService().addContext('consultation-1', { type: ContextItemType.CASE_NOTE, content: 'Patient reports a dry cough.' });

    expect(createdEntity()).toMatchObject({ contentWordCount: 5, contentCharCount: 28 });
  });

  it('persists a TRANSCRIPT’s counts through the same chokepoint', async () => {
    // Every text write on this plane reaches the factory through `addContext`, so one
    // measurement point covers CASE_NOTE, TRANSCRIPT, WORKNOTE, PRE_SUMMARY and STRUCTURED.
    await makeService().addTranscript('consultation-1', 'doctor: good morning\npatient: good morning');

    expect(createdEntity()).toMatchObject({ contentWordCount: 6, contentCharCount: 42 });
  });

  it('counts CODE POINTS, not UTF-16 units', async () => {
    // A `.length` would over-count Malayalam and every emoji a clinician pastes, and the figure
    // is unverifiable afterwards without a PHI decrypt.
    await makeService().addContext('consultation-1', { type: ContextItemType.CASE_NOTE, content: 'പനി 🤒' });

    expect(createdEntity()).toMatchObject({ contentWordCount: 2, contentCharCount: 5 });
  });

  it('persists 0, not NULL, for a body that is genuinely empty', async () => {
    // A media item MAY carry an empty caption (the content-required guard covers non-media
    // only). `0` says "measured, and it was empty"; NULL says "never measured", and a pane that
    // conflates them reports a confident zero for every pre-TASK-999 row.
    await makeService().addContext('consultation-1', { type: ContextItemType.ATTACHMENT, content: '', mediaId: 'media-1' });

    expect(createdEntity()).toMatchObject({ contentWordCount: 0, contentCharCount: 0 });
  });

  it('leaves the counters absent when there is no body at all', async () => {
    // An attachment with no caption was never measured, and must not claim to have been.
    await makeService().addContext('consultation-1', { type: ContextItemType.ATTACHMENT, mediaId: 'media-1' });

    const entity = createdEntity();
    expect(entity.contentWordCount).toBeUndefined();
    expect(entity.contentCharCount).toBeUndefined();
  });
});

describe('updateContext — the counters move with the body (TASK-999 D-3(a))', () => {
  it('restamps both counters when the content is edited', async () => {
    // A counter left behind on an edit is worse than no counter: the pane would render a
    // confident figure for text that is no longer there, and nothing downstream can check it.
    const existing = {
      ...savedEntity({ id: 'ctx-1', content: 'old' }),
      tenantId: 'tenant-1',
      changes: {} as Record<string, unknown>,
      markQdrantNeedsSync: vi.fn(),
      updatedBy: null,
      contentWordCount: 1,
      contentCharCount: 3,
    };
    mockContextItemRepository.findById.mockResolvedValue(existing);
    mockContextItemRepository.update.mockResolvedValue(existing);

    await makeService().updateContext('ctx-1', { content: 'a much longer clinical note now' });

    expect(existing.contentWordCount).toBe(6);
    expect(existing.contentCharCount).toBe(31);
  });
});
