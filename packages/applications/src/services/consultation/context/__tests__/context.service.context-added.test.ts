/**
 * ContextService — ContextAdded fan-out + metadata persistence
 * (Clinical Workflow Playground WS2 / WS5)
 *
 * Verifies:
 *   - addContext emits ConsultationPipelineEvent.ContextAdded for human-authored
 *     note/attachment types (WORKNOTE / CASE_NOTE / ATTACHMENT) so the
 *     LiveDocumentationService folds them into the running summary.
 *   - the lab/exam `metadata.subType = 'LAB_RESULT'` convention rides along in
 *     the event payload and is persisted on the entity (no new enum).
 *   - TRANSCRIPT does NOT emit ContextAdded (it drives the harness pipeline via
 *     TranscriptionCreated instead).
 */
import { ContextItemType, SysEventType } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextService } from '../context.service';
import { ConsultationPipelineEvent } from '../../events';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

let capturedCreateEntity: any;
const mockContextItemRepository = {
  create: vi.fn(),
};
const mockContextItemVersionRepository = {
  create: vi.fn().mockResolvedValue({ id: 'v1' }),
  getLatestVersionNumber: vi.fn().mockResolvedValue(0),
};
const mockAudioRecordingRepository = {};
const mockSummaryMetaRepository = {};
const mockNamedEntityRepository = {};
const mockConsultationRepository = {
  findById: vi.fn().mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' }),
};

function makeSaved(id: string, type: ContextItemType) {
  return {
    id,
    consultationId: 'consultation-1',
    type,
    source: 'USER',
    content: 'x',
    metaData: undefined,
    currentVersionNumber: 1,
    qdrantSynced: false,
    qdrantSyncedAt: null,
    isSummary: false,
    isFinalSummary: false,
    isPreSummary: false,
    isTranscript: type === ContextItemType.TRANSCRIPT,
    isCaseNote: type === ContextItemType.CASE_NOTE,
    isWorknote: type === ContextItemType.WORKNOTE,
    isNamedEntity: false,
    isAttachment: type === ContextItemType.ATTACHMENT,
    isAiGenerated: false,
    requiresContent: type !== ContextItemType.ATTACHMENT,
    createdAt: new Date('2026-06-08T00:00:00Z'),
    updatedAt: new Date('2026-06-08T00:00:00Z'),
  } as any;
}

describe('ContextService — ContextAdded fan-out + lab subType', () => {
  let service: ContextService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContextItemVersionRepository.getLatestVersionNumber.mockResolvedValue(0);
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'user') return { id: 'doc-1' };
      if (key === 'tenantId') return 'tenant-1';
      return null;
    });
    mockContextItemRepository.create.mockImplementation((entity: any) => {
      capturedCreateEntity = entity;
      return Promise.resolve(makeSaved('ctx-new', entity.type));
    });

    service = new ContextService(
      mockContextItemRepository as any,
      mockContextItemVersionRepository as any,
      mockAudioRecordingRepository as any,
      mockSummaryMetaRepository as any,
      mockNamedEntityRepository as any,
      mockConsultationRepository as any,
      mockEventEmitter as any,
      mockClsService as any,
    );
  });

  it('emits ContextAdded with the lab subType for an ATTACHMENT and persists metadata', async () => {
    await service.addContext('consultation-1', {
      type: ContextItemType.ATTACHMENT,
      content: 'CBC panel attached',
      mediaId: 'media-9',
      metadata: { subType: 'LAB_RESULT' },
    });

    // metadata persisted on the entity handed to the repository
    expect(capturedCreateEntity.metaData).toEqual({ subType: 'LAB_RESULT' });

    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      ConsultationPipelineEvent.ContextAdded,
      expect.objectContaining({
        consultationId: 'consultation-1',
        tenantId: 'tenant-1',
        contextItemId: 'ctx-new',
        contextType: ContextItemType.ATTACHMENT,
        subType: 'LAB_RESULT',
        contentPreview: 'CBC panel attached',
      }),
    );
  });

  it('emits ContextAdded for a WORKNOTE (no subType)', async () => {
    await service.addContext('consultation-1', {
      type: ContextItemType.WORKNOTE,
      content: 'BP elevated, monitor',
    });

    const contextAddedCalls = mockEventEmitter.emit.mock.calls.filter((c) => c[0] === ConsultationPipelineEvent.ContextAdded);
    expect(contextAddedCalls).toHaveLength(1);
    expect(contextAddedCalls[0][1]).toMatchObject({ contextType: ContextItemType.WORKNOTE, subType: undefined });
  });

  it('does NOT emit ContextAdded for a TRANSCRIPT (harness pipeline owns that)', async () => {
    await service.addContext('consultation-1', {
      type: ContextItemType.TRANSCRIPT,
      content: 'doctor: hello',
    });

    const contextAddedCalls = mockEventEmitter.emit.mock.calls.filter((c) => c[0] === ConsultationPipelineEvent.ContextAdded);
    expect(contextAddedCalls).toHaveLength(0);
    // the standard ResourceCreated sys-event still fires
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.any(Object));
  });
});
