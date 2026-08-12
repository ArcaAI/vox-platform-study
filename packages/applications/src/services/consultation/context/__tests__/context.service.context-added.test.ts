/**
 * ContextService — ContextAdded fan-out + metadata persistence
 * (Clinical Workflow Playground WS2 / WS5; widened by TASK-660)
 *
 * Verifies:
 *   - addContext emits ConsultationPipelineEvent.ContextAdded for human-authored
 *     note/attachment types (WORKNOTE / CASE_NOTE / ATTACHMENT) so the
 *     LiveDocumentationService folds them into the running summary.
 *   - the lab/exam `metadata.subType = 'LAB_RESULT'` convention rides along in
 *     the event payload and is persisted on the entity (no new enum).
 *   - TASK-660 — the gate widened: TRANSCRIPT and the tenant-declared
 *     STRUCTURED primitive now ALSO emit ContextAdded (the loop event plane's
 *     context bus needs transcripts and derived context to re-enter it).
 *     TRANSCRIPT still ALSO drives the harness pipeline via
 *     TranscriptionCreated — that emission is unrelated and unaffected.
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
  findById: vi.fn(),
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

  // TASK-660 — widened: the loop event plane's context bus needs transcripts
  // to re-enter it. TRANSCRIPT ALSO still drives the harness pipeline via a
  // SEPARATE TranscriptionCreated emission (sttInternal.service.ts) — that is
  // untouched by this change.
  it('emits ContextAdded for a TRANSCRIPT (loop event plane widening)', async () => {
    await service.addContext('consultation-1', {
      type: ContextItemType.TRANSCRIPT,
      content: 'doctor: hello',
    });

    const contextAddedCalls = mockEventEmitter.emit.mock.calls.filter((c) => c[0] === ConsultationPipelineEvent.ContextAdded);
    expect(contextAddedCalls).toHaveLength(1);
    expect(contextAddedCalls[0][1]).toMatchObject({ contextType: ContextItemType.TRANSCRIPT });
    // the standard ResourceCreated sys-event still fires
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.any(Object));
  });

  // TASK-660 — the tenant-declared STRUCTURED primitive (TASK-658) is the
  // other "derived kind" the widened gate covers.
  it('emits ContextAdded for a STRUCTURED item (loop event plane widening)', async () => {
    await service.addContext('consultation-1', {
      type: ContextItemType.STRUCTURED,
      content: '{"bp":"120/80"}',
    });

    const contextAddedCalls = mockEventEmitter.emit.mock.calls.filter((c) => c[0] === ConsultationPipelineEvent.ContextAdded);
    expect(contextAddedCalls).toHaveLength(1);
    expect(contextAddedCalls[0][1]).toMatchObject({ contextType: ContextItemType.STRUCTURED });
  });

  // TASK-670 — cascade depth: derived context must arrive at parent.depth + 1
  // so TASK-664's depth-cap budget is a real bound, not a nominal field.
  describe('cascade depth (derivedFromContextItemId)', () => {
    it('depth 0 when no lineage is declared (regression — unchanged metaData shape)', async () => {
      await service.addContext('consultation-1', {
        type: ContextItemType.WORKNOTE,
        content: 'BP elevated, monitor',
      });

      expect(mockContextItemRepository.findById).not.toHaveBeenCalled();
      const contextAddedCalls = mockEventEmitter.emit.mock.calls.filter((c) => c[0] === ConsultationPipelineEvent.ContextAdded);
      expect(contextAddedCalls[0][1]).toMatchObject({ depth: 0 });
      // metaData stays undefined — no loopDepth key added for a normal write.
      expect(capturedCreateEntity.metaData).toBeUndefined();
    });

    it('resolves depth = parent.depth + 1 and persists metaData.loopDepth on the child', async () => {
      mockContextItemRepository.findById.mockResolvedValue({
        id: 'ctx-parent',
        tenantId: 'tenant-1',
        metaData: { loopDepth: 2 },
      });

      await service.addContext('consultation-1', {
        type: ContextItemType.STRUCTURED,
        content: '{"finding":"elevated troponin"}',
        derivedFromContextItemId: 'ctx-parent',
      });

      expect(mockContextItemRepository.findById).toHaveBeenCalledWith('ctx-parent');
      const contextAddedCalls = mockEventEmitter.emit.mock.calls.filter((c) => c[0] === ConsultationPipelineEvent.ContextAdded);
      expect(contextAddedCalls[0][1]).toMatchObject({ depth: 3 });
      expect(capturedCreateEntity.metaData).toEqual({ loopDepth: 3 });
    });

    it('depth 1 when the named parent has no recorded loopDepth (treated as parent depth 0)', async () => {
      mockContextItemRepository.findById.mockResolvedValue({ id: 'ctx-parent', tenantId: 'tenant-1', metaData: undefined });

      await service.addContext('consultation-1', {
        type: ContextItemType.STRUCTURED,
        content: '{"finding":"x"}',
        derivedFromContextItemId: 'ctx-parent',
      });

      const contextAddedCalls = mockEventEmitter.emit.mock.calls.filter((c) => c[0] === ConsultationPipelineEvent.ContextAdded);
      expect(contextAddedCalls[0][1]).toMatchObject({ depth: 1 });
    });

    it('degrades to depth 0 (best-effort) when the named parent is cross-tenant', async () => {
      mockContextItemRepository.findById.mockResolvedValue({ id: 'ctx-parent', tenantId: 'tenant-OTHER', metaData: { loopDepth: 5 } });

      await service.addContext('consultation-1', {
        type: ContextItemType.STRUCTURED,
        content: '{"finding":"x"}',
        derivedFromContextItemId: 'ctx-parent',
      });

      const contextAddedCalls = mockEventEmitter.emit.mock.calls.filter((c) => c[0] === ConsultationPipelineEvent.ContextAdded);
      expect(contextAddedCalls[0][1]).toMatchObject({ depth: 0 });
      // The write still SUCCEEDS and still records the (degraded) depth — lineage
      // bookkeeping never blocks persisting clinical content.
      expect(capturedCreateEntity.metaData).toEqual({ loopDepth: 0 });
    });

    it('degrades to depth 0 (best-effort) when the named parent does not exist', async () => {
      mockContextItemRepository.findById.mockRejectedValue(new Error('not found'));

      await service.addContext('consultation-1', {
        type: ContextItemType.STRUCTURED,
        content: '{"finding":"x"}',
        derivedFromContextItemId: 'ctx-missing',
      });

      const contextAddedCalls = mockEventEmitter.emit.mock.calls.filter((c) => c[0] === ConsultationPipelineEvent.ContextAdded);
      expect(contextAddedCalls[0][1]).toMatchObject({ depth: 0 });
    });
  });

  // TASK-670 — payload completeness: the fuller `content` field rides
  // alongside the pre-existing, unchanged `contentPreview` (kindKey coverage
  // lives in the ATTACHMENT/dedicated-kind path — this asserts `content` is
  // wired without depending on the schema-validation constructor args).
  it('emits the fuller content field alongside the unchanged contentPreview', async () => {
    await service.addContext('consultation-1', {
      type: ContextItemType.WORKNOTE,
      content: 'BP elevated, monitor closely for the next hour',
    });

    const contextAddedCalls = mockEventEmitter.emit.mock.calls.filter((c) => c[0] === ConsultationPipelineEvent.ContextAdded);
    expect(contextAddedCalls[0][1]).toMatchObject({
      contentPreview: 'BP elevated, monitor closely for the next hour',
      content: 'BP elevated, monitor closely for the next hour',
    });
  });
});
