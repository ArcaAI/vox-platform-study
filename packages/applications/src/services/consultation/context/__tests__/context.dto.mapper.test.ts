/**
 * ContextDtoMapper Unit Tests
 *
 * Tests for the ContextDtoMapper that transforms context item entities to response DTOs.
 * Updated for the new data model with enum types and nested relations.
 */

import { describe, it, expect } from 'vitest';
import { ContextDtoMapper } from '../context.dto.mapper';

// Enum values as strings (to avoid import issues during testing)
const ContextItemType = {
  TRANSCRIPT: 'TRANSCRIPT',
  WORKNOTE: 'WORKNOTE',
  RAW_SUMMARY: 'RAW_SUMMARY',
  MODIFIED_SUMMARY: 'MODIFIED_SUMMARY',
  PRE_SUMMARY: 'PRE_SUMMARY',
  NAMED_ENTITY: 'NAMED_ENTITY',
  CASE_NOTE: 'CASE_NOTE',
  ATTACHMENT: 'ATTACHMENT',
  AUDIO_RECORDING: 'AUDIO_RECORDING',
} as const;

const ContextItemSource = {
  USER: 'USER',
  AI: 'AI',
  SYSTEM: 'SYSTEM',
  TRANSCRIPTION: 'TRANSCRIPTION',
} as const;

// Helper to create mock context item entity with new enum types
const createMockContextItemEntity = (
  overrides: Partial<{
    id: string;
    consultationId: string;
    type: string;
    source: string;
    content: string | null;
    dnaWritingStyleId: string | null;
    currentVersionNumber: number;
    version: number;
    qdrantSynced: boolean;
    qdrantSyncedAt: Date | null;
    isSummary: boolean;
    isFinalSummary: boolean;
    isPreSummary: boolean;
    isTranscript: boolean;
    isCaseNote: boolean;
    isWorknote: boolean;
    isNamedEntity: boolean;
    isAttachment: boolean;
    isAiGenerated: boolean;
    requiresContent: boolean;
    AudioRecordings: any[] | null;
    SummaryMeta: any | null;
    NamedEntities: any[] | null;
    Versions: any[] | null;
    createdAt: Date;
    updatedAt: Date;
  }> = {},
) => ({
  id: overrides.id ?? 'context-item-id-1',
  consultationId: overrides.consultationId ?? 'consultation-1',
  type: overrides.type ?? ContextItemType.TRANSCRIPT,
  source: overrides.source ?? ContextItemSource.USER,
  content: 'content' in overrides ? overrides.content : 'Test content',
  dnaWritingStyleId: 'dnaWritingStyleId' in overrides ? overrides.dnaWritingStyleId : null,
  currentVersionNumber: overrides.currentVersionNumber ?? 1,
  // the OCC counter (`_version`) — DISTINCT from
  // `currentVersionNumber` above (the content-revision pointer).
  version: overrides.version ?? 1,
  qdrantSynced: overrides.qdrantSynced ?? false,
  qdrantSyncedAt: 'qdrantSyncedAt' in overrides ? overrides.qdrantSyncedAt : null,
  isSummary: overrides.isSummary ?? false,
  isFinalSummary: overrides.isFinalSummary ?? false,
  isPreSummary: overrides.isPreSummary ?? false,
  isTranscript: overrides.isTranscript ?? true,
  isCaseNote: overrides.isCaseNote ?? false,
  isWorknote: overrides.isWorknote ?? false,
  isNamedEntity: overrides.isNamedEntity ?? false,
  isAttachment: overrides.isAttachment ?? false,
  isAiGenerated: overrides.isAiGenerated ?? false,
  requiresContent: overrides.requiresContent ?? true,
  AudioRecordings: overrides.AudioRecordings ?? null,
  SummaryMeta: overrides.SummaryMeta ?? null,
  NamedEntities: overrides.NamedEntities ?? null,
  Versions: overrides.Versions ?? null,
  createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:30:00Z'),
});

// Helper to create mock audio recording entity
const createMockAudioRecordingEntity = (
  overrides: Partial<{
    id: string;
    mediaId: string;
    rawMediaId: string | null;
    processedMediaId: string | null;
    duration: number | null;
    durationFormatted: string | null;
    format: string | null;
    sampleRate: number | null;
    channels: number | null;
    bitrate: number | null;
    language: string | null;
    sequenceNumber: number;
    recordedAt: Date | null;
    createdAt: Date;
  }> = {},
) => ({
  id: overrides.id ?? 'audio-recording-id-1',
  mediaId: overrides.mediaId ?? 'media-uuid-123',
  rawMediaId: 'rawMediaId' in overrides ? overrides.rawMediaId : null,
  processedMediaId: 'processedMediaId' in overrides ? overrides.processedMediaId : null,
  duration: 'duration' in overrides ? overrides.duration : 180000,
  durationFormatted: 'durationFormatted' in overrides ? overrides.durationFormatted : '03:00',
  format: 'format' in overrides ? overrides.format : 'mp3',
  sampleRate: 'sampleRate' in overrides ? overrides.sampleRate : 44100,
  channels: 'channels' in overrides ? overrides.channels : 2,
  bitrate: 'bitrate' in overrides ? overrides.bitrate : 128000,
  language: 'language' in overrides ? overrides.language : 'en',
  sequenceNumber: overrides.sequenceNumber ?? 1,
  recordedAt: 'recordedAt' in overrides ? overrides.recordedAt : new Date('2026-01-29T09:00:00Z'),
  createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
});

// Helper to create mock summary meta entity
const createMockSummaryMetaEntity = (
  overrides: Partial<{
    id: string;
    aiModelId: string | null;
    aiModelVersion: string | null;
    promptVersion: string | null;
    processingTimeMs: number | null;
    processingTimeSeconds: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number;
    caseNoteIds: string[];
    preSummaryIds: string[];
    previousSummaryIds: string[];
    hasAnyContext: boolean;
    generatedAt: Date | null;
    createdAt: Date;
    promptResolvedFrom: string | null;
    resolvedPromptId: string | null;
  }> = {},
) => ({
  id: overrides.id ?? 'summary-meta-id-1',
  aiModelId: 'aiModelId' in overrides ? overrides.aiModelId : 'gpt-4',
  aiModelVersion: 'aiModelVersion' in overrides ? overrides.aiModelVersion : '1.0',
  promptVersion: 'promptVersion' in overrides ? overrides.promptVersion : 'v2',
  processingTimeMs: 'processingTimeMs' in overrides ? overrides.processingTimeMs : 2500,
  processingTimeSeconds: 'processingTimeSeconds' in overrides ? overrides.processingTimeSeconds : 2.5,
  inputTokens: 'inputTokens' in overrides ? overrides.inputTokens : 1000,
  outputTokens: 'outputTokens' in overrides ? overrides.outputTokens : 500,
  totalTokens: overrides.totalTokens ?? 1500,
  caseNoteIds: overrides.caseNoteIds ?? [],
  preSummaryIds: overrides.preSummaryIds ?? [],
  previousSummaryIds: overrides.previousSummaryIds ?? [],
  hasAnyContext: overrides.hasAnyContext ?? false,
  generatedAt: 'generatedAt' in overrides ? overrides.generatedAt : new Date('2026-01-29T10:00:00Z'),
  createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
  promptResolvedFrom: 'promptResolvedFrom' in overrides ? overrides.promptResolvedFrom : null,
  resolvedPromptId: 'resolvedPromptId' in overrides ? overrides.resolvedPromptId : null,
});

// Helper to create mock named entity
const createMockNamedEntityEntity = (
  overrides: Partial<{
    id: string;
    text: string;
    className: string;
    normalizedText: string | null;
    displayText: string;
    startOffset: number | null;
    endOffset: number | null;
    confidence: number | null;
    isHighConfidence: boolean;
    aiModelId: string | null;
    aiModelVersion: string | null;
    processingTimeMs: number | null;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  }> = {},
) => ({
  id: overrides.id ?? 'named-entity-id-1',
  text: overrides.text ?? 'Aspirin',
  className: overrides.className ?? 'MEDICATION',
  normalizedText: 'normalizedText' in overrides ? overrides.normalizedText : 'acetylsalicylic acid',
  displayText: overrides.displayText ?? 'acetylsalicylic acid',
  startOffset: 'startOffset' in overrides ? overrides.startOffset : 10,
  endOffset: 'endOffset' in overrides ? overrides.endOffset : 17,
  confidence: 'confidence' in overrides ? overrides.confidence : 0.95,
  isHighConfidence: overrides.isHighConfidence ?? true,
  aiModelId: 'aiModelId' in overrides ? overrides.aiModelId : 'ner-model-1',
  aiModelVersion: 'aiModelVersion' in overrides ? overrides.aiModelVersion : '2.0',
  processingTimeMs: 'processingTimeMs' in overrides ? overrides.processingTimeMs : 50,
  metadata: 'metadata' in overrides ? overrides.metadata : { icd10: 'N02.0' },
  createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
});

// Helper to create mock context item version entity
const createMockContextItemVersionEntity = (
  overrides: Partial<{
    id: string;
    contextItemId: string;
    versionNumber: number;
    content: string | null;
    contentDiff: string | null;
    changeReason: string | null;
    changeSummary: string | null;
    changedBy: string | null;
    changeSource: string | null;
    fieldChanges: Record<string, unknown> | null;
    createdAt: Date;
  }> = {},
) => ({
  id: overrides.id ?? 'version-id-1',
  contextItemId: overrides.contextItemId ?? 'context-item-id-1',
  versionNumber: overrides.versionNumber ?? 1,
  content: 'content' in overrides ? overrides.content : 'Version content',
  contentDiff: 'contentDiff' in overrides ? overrides.contentDiff : null,
  changeReason: 'changeReason' in overrides ? overrides.changeReason : 'user_edit',
  changeSummary: 'changeSummary' in overrides ? overrides.changeSummary : 'Updated content',
  changedBy: 'changedBy' in overrides ? overrides.changedBy : 'user-id-1',
  changeSource: 'changeSource' in overrides ? overrides.changeSource : 'manual',
  fieldChanges: 'fieldChanges' in overrides ? overrides.fieldChanges : null,
  createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
});

describe('ContextDtoMapper', () => {
  describe('toResponse', () => {
    it('should map basic context item entity to response with enum types', () => {
      const entity = createMockContextItemEntity();

      const result = ContextDtoMapper.toResponse(entity as any);

      expect(result.id).toBe('context-item-id-1');
      expect(result.consultationId).toBe('consultation-1');
      expect(result.type).toBe(ContextItemType.TRANSCRIPT);
      expect(result.source).toBe(ContextItemSource.USER);
      expect(result.content).toBe('Test content');
      expect(result.currentVersionNumber).toBe(1);
      expect(result.qdrantSynced).toBe(false);
      expect(result.createdAt).toBe('2026-01-29T10:00:00.000Z');
      expect(result.updatedAt).toBe('2026-01-29T10:30:00.000Z');
    });

    // `version` (the OCC compare-and-set counter) must be surfaced
    // so SDK clients can echo it back via `If-Match`/`expectedVersion`. It
    // is DISTINCT from `currentVersionNumber` (the content-revision pointer).
    it('should map version (OCC counter) distinctly from currentVersionNumber', () => {
      const entity = createMockContextItemEntity({ version: 7, currentVersionNumber: 3 });

      const result = ContextDtoMapper.toResponse(entity as any);

      expect(result.version).toBe(7);
      expect(result.currentVersionNumber).toBe(3);
    });

    it('should map dnaWritingStyleId when present', () => {
      const entity = createMockContextItemEntity({
        dnaWritingStyleId: 'dna-style-123',
      });

      const result = ContextDtoMapper.toResponse(entity as any);

      expect(result.dnaWritingStyleId).toBe('dna-style-123');
    });

    it('should return undefined for dnaWritingStyleId when null', () => {
      const entity = createMockContextItemEntity({ dnaWritingStyleId: null });

      const result = ContextDtoMapper.toResponse(entity as any);

      expect(result.dnaWritingStyleId).toBeUndefined();
    });

    it('should map content when present', () => {
      const entity = createMockContextItemEntity({ content: 'Some text content' });

      const result = ContextDtoMapper.toResponse(entity as any);

      expect(result.content).toBe('Some text content');
    });

    it('should return undefined for content when null', () => {
      const entity = createMockContextItemEntity({ content: null });

      const result = ContextDtoMapper.toResponse(entity as any);

      expect(result.content).toBeUndefined();
    });

    it('should map qdrantSyncedAt when present', () => {
      const syncedAt = new Date('2026-01-29T11:00:00Z');
      const entity = createMockContextItemEntity({
        qdrantSynced: true,
        qdrantSyncedAt: syncedAt,
      });

      const result = ContextDtoMapper.toResponse(entity as any);

      expect(result.qdrantSynced).toBe(true);
      expect(result.qdrantSyncedAt).toBe('2026-01-29T11:00:00.000Z');
    });

    it('should map isSummary flag correctly', () => {
      const summaryEntity = createMockContextItemEntity({
        type: ContextItemType.RAW_SUMMARY,
        isSummary: true,
      });
      const nonSummaryEntity = createMockContextItemEntity({
        type: ContextItemType.TRANSCRIPT,
        isSummary: false,
      });

      expect(ContextDtoMapper.toResponse(summaryEntity as any).isSummary).toBe(true);
      expect(ContextDtoMapper.toResponse(nonSummaryEntity as any).isSummary).toBe(false);
    });

    it('should map isTranscript flag correctly', () => {
      const transcriptEntity = createMockContextItemEntity({
        type: ContextItemType.TRANSCRIPT,
        isTranscript: true,
      });
      const nonTranscriptEntity = createMockContextItemEntity({
        type: ContextItemType.CASE_NOTE,
        isTranscript: false,
      });

      expect(ContextDtoMapper.toResponse(transcriptEntity as any).isTranscript).toBe(true);
      expect(ContextDtoMapper.toResponse(nonTranscriptEntity as any).isTranscript).toBe(false);
    });

    it('should map isAiGenerated flag correctly', () => {
      const aiEntity = createMockContextItemEntity({
        source: ContextItemSource.AI,
        isAiGenerated: true,
      });
      const userEntity = createMockContextItemEntity({
        source: ContextItemSource.USER,
        isAiGenerated: false,
      });

      expect(ContextDtoMapper.toResponse(aiEntity as any).isAiGenerated).toBe(true);
      expect(ContextDtoMapper.toResponse(userEntity as any).isAiGenerated).toBe(false);
    });

    it('should map isFinalSummary flag correctly', () => {
      const rawSummaryEntity = createMockContextItemEntity({
        type: ContextItemType.RAW_SUMMARY,
        isSummary: true,
        isFinalSummary: true,
        isPreSummary: false,
      });
      const modifiedSummaryEntity = createMockContextItemEntity({
        type: ContextItemType.MODIFIED_SUMMARY,
        isSummary: true,
        isFinalSummary: true,
        isPreSummary: false,
      });
      const preSummaryEntity = createMockContextItemEntity({
        type: ContextItemType.PRE_SUMMARY,
        isSummary: true,
        isFinalSummary: false,
        isPreSummary: true,
      });

      expect(ContextDtoMapper.toResponse(rawSummaryEntity as any).isFinalSummary).toBe(true);
      expect(ContextDtoMapper.toResponse(modifiedSummaryEntity as any).isFinalSummary).toBe(true);
      expect(ContextDtoMapper.toResponse(preSummaryEntity as any).isFinalSummary).toBe(false);
    });

    it('should map isPreSummary flag correctly', () => {
      const preSummaryEntity = createMockContextItemEntity({
        type: ContextItemType.PRE_SUMMARY,
        isSummary: true,
        isFinalSummary: false,
        isPreSummary: true,
      });
      const rawSummaryEntity = createMockContextItemEntity({
        type: ContextItemType.RAW_SUMMARY,
        isSummary: true,
        isFinalSummary: true,
        isPreSummary: false,
      });

      expect(ContextDtoMapper.toResponse(preSummaryEntity as any).isPreSummary).toBe(true);
      expect(ContextDtoMapper.toResponse(rawSummaryEntity as any).isPreSummary).toBe(false);
    });

    it('should correctly identify PRE_SUMMARY as a summary type', () => {
      const preSummaryEntity = createMockContextItemEntity({
        type: ContextItemType.PRE_SUMMARY,
        source: ContextItemSource.AI,
        isSummary: true,
        isFinalSummary: false,
        isPreSummary: true,
        isAiGenerated: true,
      });

      const result = ContextDtoMapper.toResponse(preSummaryEntity as any);

      expect(result.type).toBe(ContextItemType.PRE_SUMMARY);
      expect(result.isSummary).toBe(true);
      expect(result.isFinalSummary).toBe(false);
      expect(result.isPreSummary).toBe(true);
      expect(result.isAiGenerated).toBe(true);
    });

    it('should map isMediaType based on requiresContent', () => {
      const audioEntity = createMockContextItemEntity({
        type: ContextItemType.AUDIO_RECORDING,
        requiresContent: false,
      });
      const textEntity = createMockContextItemEntity({
        type: ContextItemType.TRANSCRIPT,
        requiresContent: true,
      });

      expect(ContextDtoMapper.toResponse(audioEntity as any).isMediaType).toBe(true);
      expect(ContextDtoMapper.toResponse(textEntity as any).isMediaType).toBe(false);
    });

    it('should map isCaseNote flag correctly', () => {
      const caseNoteEntity = createMockContextItemEntity({
        type: ContextItemType.CASE_NOTE,
        isCaseNote: true,
      });
      const nonCaseNoteEntity = createMockContextItemEntity({
        type: ContextItemType.TRANSCRIPT,
        isCaseNote: false,
      });

      expect(ContextDtoMapper.toResponse(caseNoteEntity as any).isCaseNote).toBe(true);
      expect(ContextDtoMapper.toResponse(nonCaseNoteEntity as any).isCaseNote).toBe(false);
    });

    it('should map isWorknote flag correctly', () => {
      const worknoteEntity = createMockContextItemEntity({
        type: ContextItemType.WORKNOTE,
        isWorknote: true,
      });
      const nonWorknoteEntity = createMockContextItemEntity({
        type: ContextItemType.TRANSCRIPT,
        isWorknote: false,
      });

      expect(ContextDtoMapper.toResponse(worknoteEntity as any).isWorknote).toBe(true);
      expect(ContextDtoMapper.toResponse(nonWorknoteEntity as any).isWorknote).toBe(false);
    });

    it('should map isNamedEntity flag correctly', () => {
      const nerEntity = createMockContextItemEntity({
        type: ContextItemType.NAMED_ENTITY,
        isNamedEntity: true,
      });
      const nonNerEntity = createMockContextItemEntity({
        type: ContextItemType.TRANSCRIPT,
        isNamedEntity: false,
      });

      expect(ContextDtoMapper.toResponse(nerEntity as any).isNamedEntity).toBe(true);
      expect(ContextDtoMapper.toResponse(nonNerEntity as any).isNamedEntity).toBe(false);
    });

    it('should map isAttachment flag correctly', () => {
      const attachmentEntity = createMockContextItemEntity({
        type: ContextItemType.ATTACHMENT,
        isAttachment: true,
        requiresContent: false,
      });
      const nonAttachmentEntity = createMockContextItemEntity({
        type: ContextItemType.TRANSCRIPT,
        isAttachment: false,
      });

      expect(ContextDtoMapper.toResponse(attachmentEntity as any).isAttachment).toBe(true);
      expect(ContextDtoMapper.toResponse(nonAttachmentEntity as any).isAttachment).toBe(false);
    });

    it('should map all context item types correctly', () => {
      const types = [
        ContextItemType.AUDIO_RECORDING,
        ContextItemType.WORKNOTE,
        ContextItemType.RAW_SUMMARY,
        ContextItemType.MODIFIED_SUMMARY,
        ContextItemType.PRE_SUMMARY,
        ContextItemType.NAMED_ENTITY,
        ContextItemType.TRANSCRIPT,
        ContextItemType.CASE_NOTE,
        ContextItemType.ATTACHMENT,
      ];

      types.forEach((type) => {
        const entity = createMockContextItemEntity({ type });
        const result = ContextDtoMapper.toResponse(entity as any);
        expect(result.type).toBe(type);
      });
    });

    it('should map all source types correctly', () => {
      const sources = [ContextItemSource.USER, ContextItemSource.AI, ContextItemSource.SYSTEM, ContextItemSource.TRANSCRIPTION];

      sources.forEach((source) => {
        const entity = createMockContextItemEntity({ source });
        const result = ContextDtoMapper.toResponse(entity as any);
        expect(result.source).toBe(source);
      });
    });

    it('should handle entity with all fields populated', () => {
      const entity = createMockContextItemEntity({
        id: 'full-entity-id',
        consultationId: 'full-consultation-id',
        type: ContextItemType.RAW_SUMMARY,
        source: ContextItemSource.AI,
        content: 'Full content here',
        dnaWritingStyleId: 'dna-123',
        currentVersionNumber: 5,
        qdrantSynced: true,
        qdrantSyncedAt: new Date('2026-01-29T12:00:00Z'),
        isSummary: true,
        isTranscript: false,
        isAiGenerated: true,
        requiresContent: true,
      });

      const result = ContextDtoMapper.toResponse(entity as any);

      expect(result.id).toBe('full-entity-id');
      expect(result.consultationId).toBe('full-consultation-id');
      expect(result.type).toBe(ContextItemType.RAW_SUMMARY);
      expect(result.source).toBe(ContextItemSource.AI);
      expect(result.content).toBe('Full content here');
      expect(result.dnaWritingStyleId).toBe('dna-123');
      expect(result.currentVersionNumber).toBe(5);
      expect(result.qdrantSynced).toBe(true);
      expect(result.qdrantSyncedAt).toBe('2026-01-29T12:00:00.000Z');
      expect(result.isSummary).toBe(true);
      expect(result.isTranscript).toBe(false);
      expect(result.isAiGenerated).toBe(true);
      expect(result.isMediaType).toBe(false);
    });

    it('should handle entity with minimal fields', () => {
      const entity = createMockContextItemEntity({
        content: null,
        dnaWritingStyleId: null,
        qdrantSyncedAt: null,
      });

      const result = ContextDtoMapper.toResponse(entity as any);

      expect(result.content).toBeUndefined();
      expect(result.dnaWritingStyleId).toBeUndefined();
      expect(result.qdrantSyncedAt).toBeUndefined();
    });

    // Tests for nested relations
    describe('with AudioRecordings', () => {
      it('should map audio recordings when present', () => {
        const audioRecordings = [
          createMockAudioRecordingEntity({ id: 'audio-1', sequenceNumber: 1 }),
          createMockAudioRecordingEntity({ id: 'audio-2', sequenceNumber: 2 }),
        ];
        const entity = createMockContextItemEntity({
          type: ContextItemType.AUDIO_RECORDING,
          AudioRecordings: audioRecordings,
        });

        const result = ContextDtoMapper.toResponse(entity as any);

        expect(result.audioRecordings).toHaveLength(2);
        expect(result.audioRecordings![0].id).toBe('audio-1');
        expect(result.audioRecordings![1].id).toBe('audio-2');
      });

      it('should not include audioRecordings when null', () => {
        const entity = createMockContextItemEntity({ AudioRecordings: null });

        const result = ContextDtoMapper.toResponse(entity as any);

        expect(result.audioRecordings).toBeUndefined();
      });

      it('should not include audioRecordings when empty array', () => {
        const entity = createMockContextItemEntity({ AudioRecordings: [] });

        const result = ContextDtoMapper.toResponse(entity as any);

        expect(result.audioRecordings).toBeUndefined();
      });
    });

    describe('with SummaryMeta', () => {
      it('should map summary meta when present', () => {
        const summaryMeta = createMockSummaryMetaEntity({
          aiModelId: 'gpt-4',
          processingTimeMs: 2500,
        });
        const entity = createMockContextItemEntity({
          type: ContextItemType.RAW_SUMMARY,
          SummaryMeta: summaryMeta,
        });

        const result = ContextDtoMapper.toResponse(entity as any);

        expect(result.summaryMeta).toBeDefined();
        expect(result.summaryMeta!.aiModelId).toBe('gpt-4');
        expect(result.summaryMeta!.processingTimeMs).toBe(2500);
      });

      it('should not include summaryMeta when null', () => {
        const entity = createMockContextItemEntity({ SummaryMeta: null });

        const result = ContextDtoMapper.toResponse(entity as any);

        expect(result.summaryMeta).toBeUndefined();
      });
    });

    describe('with NamedEntities', () => {
      it('should map named entities when present', () => {
        const namedEntities = [
          createMockNamedEntityEntity({ text: 'Aspirin', className: 'MEDICATION' }),
          createMockNamedEntityEntity({ id: 'ne-2', text: 'Headache', className: 'CONDITION' }),
        ];
        const entity = createMockContextItemEntity({
          NamedEntities: namedEntities,
        });

        const result = ContextDtoMapper.toResponse(entity as any);

        expect(result.namedEntities).toHaveLength(2);
        expect(result.namedEntities![0].text).toBe('Aspirin');
        expect(result.namedEntities![1].className).toBe('CONDITION');
      });

      it('should not include namedEntities when null', () => {
        const entity = createMockContextItemEntity({ NamedEntities: null });

        const result = ContextDtoMapper.toResponse(entity as any);

        expect(result.namedEntities).toBeUndefined();
      });
    });

    describe('with Versions', () => {
      it('should map versions when present', () => {
        const versions = [
          createMockContextItemVersionEntity({ versionNumber: 2 }),
          createMockContextItemVersionEntity({ id: 'v-1', versionNumber: 1 }),
        ];
        const entity = createMockContextItemEntity({
          Versions: versions,
        });

        const result = ContextDtoMapper.toResponse(entity as any);

        expect(result.versions).toHaveLength(2);
        expect(result.versions![0].versionNumber).toBe(2);
        expect(result.versions![1].versionNumber).toBe(1);
      });

      it('should not include versions when null', () => {
        const entity = createMockContextItemEntity({ Versions: null });

        const result = ContextDtoMapper.toResponse(entity as any);

        expect(result.versions).toBeUndefined();
      });
    });
  });

  describe('toAudioRecordingResponse', () => {
    it('should map basic audio recording entity to response', () => {
      const entity = createMockAudioRecordingEntity();

      const result = ContextDtoMapper.toAudioRecordingResponse(entity as any);

      expect(result.id).toBe('audio-recording-id-1');
      expect(result.mediaId).toBe('media-uuid-123');
      expect(result.duration).toBe(180000);
      expect(result.durationFormatted).toBe('03:00');
      expect(result.format).toBe('mp3');
      expect(result.sampleRate).toBe(44100);
      expect(result.channels).toBe(2);
      expect(result.bitrate).toBe(128000);
      expect(result.language).toBe('en');
      expect(result.sequenceNumber).toBe(1);
      expect(result.recordedAt).toBe('2026-01-29T09:00:00.000Z');
      expect(result.createdAt).toBe('2026-01-29T10:00:00.000Z');
    });

    it('maps rawMediaId/processedMediaId when present, and undefined when null', () => {
      const withDual = ContextDtoMapper.toAudioRecordingResponse(
        createMockAudioRecordingEntity({ rawMediaId: 'media-raw', processedMediaId: 'media-processed' }) as any,
      );
      expect(withDual.rawMediaId).toBe('media-raw');
      expect(withDual.processedMediaId).toBe('media-processed');

      const withoutDual = ContextDtoMapper.toAudioRecordingResponse(createMockAudioRecordingEntity() as any);
      expect(withoutDual.rawMediaId).toBeUndefined();
      expect(withoutDual.processedMediaId).toBeUndefined();
    });

    it('should handle null optional fields', () => {
      const entity = createMockAudioRecordingEntity({
        duration: null,
        durationFormatted: null,
        format: null,
        sampleRate: null,
        channels: null,
        bitrate: null,
        language: null,
        recordedAt: null,
      });

      const result = ContextDtoMapper.toAudioRecordingResponse(entity as any);

      expect(result.duration).toBeUndefined();
      expect(result.durationFormatted).toBeUndefined();
      expect(result.format).toBeUndefined();
      expect(result.sampleRate).toBeUndefined();
      expect(result.channels).toBeUndefined();
      expect(result.bitrate).toBeUndefined();
      expect(result.language).toBeUndefined();
      expect(result.recordedAt).toBeUndefined();
    });

    it('should handle different audio formats', () => {
      const formats = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'webm'];

      formats.forEach((format) => {
        const entity = createMockAudioRecordingEntity({ format });
        const result = ContextDtoMapper.toAudioRecordingResponse(entity as any);
        expect(result.format).toBe(format);
      });
    });

    it('should handle mono audio (1 channel)', () => {
      const entity = createMockAudioRecordingEntity({ channels: 1 });
      const result = ContextDtoMapper.toAudioRecordingResponse(entity as any);
      expect(result.channels).toBe(1);
    });

    it('should handle stereo audio (2 channels)', () => {
      const entity = createMockAudioRecordingEntity({ channels: 2 });
      const result = ContextDtoMapper.toAudioRecordingResponse(entity as any);
      expect(result.channels).toBe(2);
    });

    it('should handle various sample rates', () => {
      const sampleRates = [8000, 16000, 22050, 44100, 48000, 96000];

      sampleRates.forEach((sampleRate) => {
        const entity = createMockAudioRecordingEntity({ sampleRate });
        const result = ContextDtoMapper.toAudioRecordingResponse(entity as any);
        expect(result.sampleRate).toBe(sampleRate);
      });
    });

    it('should handle zero duration', () => {
      const entity = createMockAudioRecordingEntity({ duration: 0 });
      const result = ContextDtoMapper.toAudioRecordingResponse(entity as any);
      expect(result.duration).toBe(0);
    });

    it('should handle very long duration', () => {
      const entity = createMockAudioRecordingEntity({ duration: 3600000 }); // 1 hour
      const result = ContextDtoMapper.toAudioRecordingResponse(entity as any);
      expect(result.duration).toBe(3600000);
    });

    it('should handle different languages', () => {
      const languages = ['en', 'es', 'fr', 'de', 'zh', 'ja', 'ko'];

      languages.forEach((language) => {
        const entity = createMockAudioRecordingEntity({ language });
        const result = ContextDtoMapper.toAudioRecordingResponse(entity as any);
        expect(result.language).toBe(language);
      });
    });

    it('should handle high sequence numbers', () => {
      const entity = createMockAudioRecordingEntity({ sequenceNumber: 999 });
      const result = ContextDtoMapper.toAudioRecordingResponse(entity as any);
      expect(result.sequenceNumber).toBe(999);
    });
  });

  describe('toSummaryMetaResponse', () => {
    it('should map basic summary meta entity to response', () => {
      const entity = createMockSummaryMetaEntity();

      const result = ContextDtoMapper.toSummaryMetaResponse(entity as any);

      expect(result.id).toBe('summary-meta-id-1');
      expect(result.aiModelId).toBe('gpt-4');
      expect(result.aiModelVersion).toBe('1.0');
      expect(result.promptVersion).toBe('v2');
      expect(result.processingTimeMs).toBe(2500);
      expect(result.processingTimeSeconds).toBe(2.5);
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
      expect(result.totalTokens).toBe(1500);
      expect(result.hasAnyContext).toBe(false);
      expect(result.generatedAt).toBe('2026-01-29T10:00:00.000Z');
    });

    it('should map prompt-resolution tier fields when present', () => {
      const entity = createMockSummaryMetaEntity({
        promptResolvedFrom: 'department',
        resolvedPromptId: 'prompt-dept-1',
      });

      const result = ContextDtoMapper.toSummaryMetaResponse(entity as any);

      expect(result.promptResolvedFrom).toBe('department');
      expect(result.resolvedPromptId).toBe('prompt-dept-1');
    });

    it('should leave prompt-resolution tier fields undefined when absent', () => {
      const entity = createMockSummaryMetaEntity();

      const result = ContextDtoMapper.toSummaryMetaResponse(entity as any);

      expect(result.promptResolvedFrom).toBeUndefined();
      expect(result.resolvedPromptId).toBeUndefined();
    });

    it('should map context IDs when present', () => {
      const entity = createMockSummaryMetaEntity({
        caseNoteIds: ['cn-1', 'cn-2'],
        preSummaryIds: ['ps-1'],
        previousSummaryIds: ['prev-1', 'prev-2', 'prev-3'],
        hasAnyContext: true,
      });

      const result = ContextDtoMapper.toSummaryMetaResponse(entity as any);

      expect(result.caseNoteIds).toEqual(['cn-1', 'cn-2']);
      expect(result.preSummaryIds).toEqual(['ps-1']);
      expect(result.previousSummaryIds).toEqual(['prev-1', 'prev-2', 'prev-3']);
      expect(result.hasAnyContext).toBe(true);
    });

    it('should not include empty context ID arrays', () => {
      const entity = createMockSummaryMetaEntity({
        caseNoteIds: [],
        preSummaryIds: [],
        previousSummaryIds: [],
      });

      const result = ContextDtoMapper.toSummaryMetaResponse(entity as any);

      expect(result.caseNoteIds).toBeUndefined();
      expect(result.preSummaryIds).toBeUndefined();
      expect(result.previousSummaryIds).toBeUndefined();
    });

    it('should handle null optional fields', () => {
      const entity = createMockSummaryMetaEntity({
        aiModelId: null,
        aiModelVersion: null,
        promptVersion: null,
        processingTimeMs: null,
        processingTimeSeconds: null,
        inputTokens: null,
        outputTokens: null,
        generatedAt: null,
      });

      const result = ContextDtoMapper.toSummaryMetaResponse(entity as any);

      expect(result.aiModelId).toBeUndefined();
      expect(result.aiModelVersion).toBeUndefined();
      expect(result.promptVersion).toBeUndefined();
      expect(result.processingTimeMs).toBeUndefined();
      expect(result.processingTimeSeconds).toBeUndefined();
      expect(result.inputTokens).toBeUndefined();
      expect(result.outputTokens).toBeUndefined();
      expect(result.generatedAt).toBeUndefined();
    });
  });

  describe('toNamedEntityResponse', () => {
    it('should map basic named entity to response', () => {
      const entity = createMockNamedEntityEntity();

      const result = ContextDtoMapper.toNamedEntityResponse(entity as any);

      expect(result.id).toBe('named-entity-id-1');
      expect(result.text).toBe('Aspirin');
      expect(result.className).toBe('MEDICATION');
      expect(result.normalizedText).toBe('acetylsalicylic acid');
      expect(result.displayText).toBe('acetylsalicylic acid');
      expect(result.startOffset).toBe(10);
      expect(result.endOffset).toBe(17);
      expect(result.confidence).toBe(0.95);
      expect(result.isHighConfidence).toBe(true);
      expect(result.aiModelId).toBe('ner-model-1');
      expect(result.aiModelVersion).toBe('2.0');
      expect(result.processingTimeMs).toBe(50);
      expect(result.metadata).toEqual({ icd10: 'N02.0' });
    });

    it('should handle null optional fields', () => {
      const entity = createMockNamedEntityEntity({
        normalizedText: null,
        startOffset: null,
        endOffset: null,
        confidence: null,
        aiModelId: null,
        aiModelVersion: null,
        processingTimeMs: null,
        metadata: null,
      });

      const result = ContextDtoMapper.toNamedEntityResponse(entity as any);

      expect(result.normalizedText).toBeUndefined();
      expect(result.startOffset).toBeUndefined();
      expect(result.endOffset).toBeUndefined();
      expect(result.confidence).toBeUndefined();
      expect(result.aiModelId).toBeUndefined();
      expect(result.aiModelVersion).toBeUndefined();
      expect(result.processingTimeMs).toBeUndefined();
      // metadata passes through as null when null
      expect(result.metadata).toBeNull();
    });

    it('should map low confidence entity correctly', () => {
      const entity = createMockNamedEntityEntity({
        confidence: 0.45,
        isHighConfidence: false,
      });

      const result = ContextDtoMapper.toNamedEntityResponse(entity as any);

      expect(result.confidence).toBe(0.45);
      expect(result.isHighConfidence).toBe(false);
    });
  });

  describe('toVersionResponse', () => {
    it('should map basic version entity to response', () => {
      const entity = createMockContextItemVersionEntity();

      const result = ContextDtoMapper.toVersionResponse(entity as any);

      expect(result.id).toBe('version-id-1');
      expect(result.contextItemId).toBe('context-item-id-1');
      expect(result.versionNumber).toBe(1);
      expect(result.content).toBe('Version content');
      expect(result.changeReason).toBe('user_edit');
      expect(result.changeSummary).toBe('Updated content');
      expect(result.changedBy).toBe('user-id-1');
      expect(result.changeSource).toBe('manual');
      expect(result.createdAt).toBe('2026-01-29T10:00:00.000Z');
    });

    it('should map contentDiff when present', () => {
      const entity = createMockContextItemVersionEntity({
        contentDiff: '{"op":"replace","path":"/content","value":"new"}',
      });

      const result = ContextDtoMapper.toVersionResponse(entity as any);

      expect(result.contentDiff).toBe('{"op":"replace","path":"/content","value":"new"}');
    });

    it('should map fieldChanges when present', () => {
      const entity = createMockContextItemVersionEntity({
        fieldChanges: { content: { old: 'old text', new: 'new text' } },
      });

      const result = ContextDtoMapper.toVersionResponse(entity as any);

      expect(result.fieldChanges).toEqual({ content: { old: 'old text', new: 'new text' } });
    });

    it('should handle null optional fields', () => {
      const entity = createMockContextItemVersionEntity({
        content: null,
        contentDiff: null,
        changeReason: null,
        changeSummary: null,
        changedBy: null,
        changeSource: null,
        fieldChanges: null,
      });

      const result = ContextDtoMapper.toVersionResponse(entity as any);

      expect(result.content).toBeUndefined();
      expect(result.contentDiff).toBeUndefined();
      expect(result.changeReason).toBeUndefined();
      expect(result.changeSummary).toBeUndefined();
      expect(result.changedBy).toBeUndefined();
      expect(result.changeSource).toBeUndefined();
      // fieldChanges passes through as null when null
      expect(result.fieldChanges).toBeNull();
    });

    it('should handle version with all fields populated', () => {
      const entity = createMockContextItemVersionEntity({
        id: 'v-123',
        contextItemId: 'ctx-456',
        versionNumber: 5,
        content: 'Full content here',
        contentDiff: '{"changes":[]}',
        changeReason: 'ai_improvement',
        changeSummary: 'AI enhanced the transcription',
        changedBy: 'ai-service',
        changeSource: 'ai',
        fieldChanges: { summary: { old: 'old', new: 'new' } },
      });

      const result = ContextDtoMapper.toVersionResponse(entity as any);

      expect(result.id).toBe('v-123');
      expect(result.contextItemId).toBe('ctx-456');
      expect(result.versionNumber).toBe(5);
      expect(result.content).toBe('Full content here');
      expect(result.contentDiff).toBe('{"changes":[]}');
      expect(result.changeReason).toBe('ai_improvement');
      expect(result.changeSummary).toBe('AI enhanced the transcription');
      expect(result.changedBy).toBe('ai-service');
      expect(result.changeSource).toBe('ai');
      expect(result.fieldChanges).toEqual({ summary: { old: 'old', new: 'new' } });
    });
  });

  // ApplyMediaUrl enriches an already-mapped response with
  // a storage-resolved (presigned) URL. Image attachments also get a thumbnail
  // (currently the image URL itself); non-images do not.
  describe('applyMediaUrl', () => {
    const baseResponse = () => ({ id: 'ci-1', mediaId: 'media-1' }) as any;

    it('sets url + mimeType + thumbnailUrl and returns the same (mutated) object', () => {
      const response = baseResponse();

      const result = ContextDtoMapper.applyMediaUrl(response, {
        url: 'https://signed.example/img.png',
        mimeType: 'image/png',
        thumbnailUrl: 'https://signed.example/img.png',
      });

      expect(result).toBe(response);
      expect(result.url).toBe('https://signed.example/img.png');
      expect(result.mimeType).toBe('image/png');
      expect(result.thumbnailUrl).toBe('https://signed.example/img.png');
    });

    it('sets url + mimeType but leaves thumbnailUrl undefined for a non-image', () => {
      const result = ContextDtoMapper.applyMediaUrl(baseResponse(), {
        url: 'https://signed.example/report.pdf',
        mimeType: 'application/pdf',
      });

      expect(result.url).toBe('https://signed.example/report.pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.thumbnailUrl).toBeUndefined();
    });
  });
});
