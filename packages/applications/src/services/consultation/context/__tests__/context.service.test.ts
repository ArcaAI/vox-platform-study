/**
 * ContextService Unit Tests
 *
 * Tests for the ContextService that handles context item operations within consultations.
 * Updated for the new data model with enum types and specialized methods.
 */

import {
    ContextItemSource,
    ContextItemType,
    SysEventType,
} from '@arcaai/domains';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextService } from '../context.service';

// Mock ClsService
const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

// Mock EventEmitter
const mockEventEmitter = {
    emit: vi.fn(),
};

// Mock ContextItemRepository
const mockContextItemRepository = {
    findById: vi.fn(),
    findByConsultation: vi.fn(),
    findSharedContext: vi.fn(),
    findCaseNotesFromChain: vi.fn(),
    findTranscripts: vi.fn(),
    findCaseNotes: vi.fn(),
    findWorknotes: vi.fn(),
    findAudioRecordings: vi.fn(),
    findSummaries: vi.fn(),
    findPreSummaries: vi.fn(),
    findWithVersions: vi.fn(),
    findWithAudioRecordings: vi.fn(),
    findWithSummaryMeta: vi.fn(),
    findWithAllRelations: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
};

// Mock ContextItemVersionRepository
const mockContextItemVersionRepository = {
    create: vi.fn(),
    getVersionHistory: vi.fn(),
    getVersion: vi.fn(),
    getLatestVersionNumber: vi.fn(),
};

// Mock AudioRecordingRepository
const mockAudioRecordingRepository = {
    create: vi.fn(),
    findByContextItem: vi.fn(),
    getNextSequenceNumber: vi.fn(),
};

// Mock SummaryMetaRepository
const mockSummaryMetaRepository = {
    create: vi.fn(),
    findByContextItem: vi.fn(),
};

// Mock NamedEntityRepository
const mockNamedEntityRepository = {
    create: vi.fn(),
    findByContextItem: vi.fn(),
    findByClassName: vi.fn(),
};

// Mock ConsultationRepository
const mockConsultationRepository = {
    findById: vi.fn(),
    findConsultationChain: vi.fn(),
    findByPatientAndDate: vi.fn(),
    findWithRelations: vi.fn(),
};

// Helper to create mock context item entity
// Use string literals for enum defaults to avoid mock issues
const createMockContextItemEntity = (overrides: Partial<{
    id: string;
    tenantId: string;
    consultationId: string;
    type: any;
    source: any;
    content: string | null;
    dnaWritingStyleId: string | null;
    currentVersionNumber: number;
    qdrantSynced: boolean;
    qdrantSyncedAt: Date | null;
    isSummary: boolean;
    isFinalSummary: boolean;
    isPreSummary: boolean;
    isTranscript: boolean;
    isAiGenerated: boolean;
    requiresContent: boolean;
    createdAt: Date;
    updatedAt: Date;
    updatedBy: string | null;
    changes: Record<string, unknown>;
}> = {}) => ({
    id: overrides.id ?? 'context-item-id-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    consultationId: overrides.consultationId ?? 'consultation-1',
    type: overrides.type ?? 'TRANSCRIPT',
    source: overrides.source ?? 'USER',
    content: 'content' in overrides ? overrides.content : 'Test content',
    dnaWritingStyleId: 'dnaWritingStyleId' in overrides ? overrides.dnaWritingStyleId : null,
    currentVersionNumber: overrides.currentVersionNumber ?? 1,
    qdrantSynced: overrides.qdrantSynced ?? false,
    qdrantSyncedAt: 'qdrantSyncedAt' in overrides ? overrides.qdrantSyncedAt : null,
    isSummary: overrides.isSummary ?? false,
    isFinalSummary: overrides.isFinalSummary ?? false,
    isPreSummary: overrides.isPreSummary ?? false,
    isTranscript: overrides.isTranscript ?? true,
    isAiGenerated: overrides.isAiGenerated ?? false,
    requiresContent: overrides.requiresContent ?? true,
    createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
    updatedBy: overrides.updatedBy ?? null,
    changes: overrides.changes ?? {},
    toObject: vi.fn().mockReturnValue({
        id: overrides.id ?? 'context-item-id-1',
        content: 'content' in overrides ? overrides.content : 'Test content',
    }),
    incrementVersion: vi.fn(),
    markQdrantNeedsSync: vi.fn(),
});

// Helper to create mock context item version entity
const createMockContextItemVersionEntity = (overrides: Partial<{
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
}> = {}) => ({
    id: overrides.id ?? 'version-id-1',
    contextItemId: overrides.contextItemId ?? 'context-item-id-1',
    versionNumber: overrides.versionNumber ?? 1,
    content: 'content' in overrides ? overrides.content : 'Version content',
    contentDiff: 'contentDiff' in overrides ? overrides.contentDiff : null,
    changeReason: 'changeReason' in overrides ? overrides.changeReason : 'user_edit',
    changeSummary: 'changeSummary' in overrides ? overrides.changeSummary : null,
    changedBy: 'changedBy' in overrides ? overrides.changedBy : 'user-id-1',
    changeSource: 'changeSource' in overrides ? overrides.changeSource : 'manual',
    fieldChanges: 'fieldChanges' in overrides ? overrides.fieldChanges : null,
    createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
});

// Helper to create mock audio recording entity
const createMockAudioRecordingEntity = (overrides: Partial<{
    id: string;
    contextItemId: string;
    mediaId: string;
    duration: number | null;
    format: string | null;
    sampleRate: number | null;
    channels: number | null;
    bitrate: number | null;
    language: string | null;
    sequenceNumber: number;
    recordedAt: Date | null;
    createdAt: Date;
}> = {}) => ({
    id: overrides.id ?? 'audio-recording-id-1',
    contextItemId: overrides.contextItemId ?? 'context-item-id-1',
    mediaId: overrides.mediaId ?? 'media-uuid-123',
    duration: 'duration' in overrides ? overrides.duration : 180000,
    format: 'format' in overrides ? overrides.format : 'mp3',
    sampleRate: 'sampleRate' in overrides ? overrides.sampleRate : 44100,
    channels: 'channels' in overrides ? overrides.channels : 2,
    bitrate: 'bitrate' in overrides ? overrides.bitrate : 128000,
    language: 'language' in overrides ? overrides.language : 'en',
    sequenceNumber: overrides.sequenceNumber ?? 1,
    recordedAt: 'recordedAt' in overrides ? overrides.recordedAt : null,
    createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
    durationFormatted: '03:00',
});

// Helper to create mock summary meta entity
const createMockSummaryMetaEntity = (overrides: Partial<{
    id: string;
    contextItemId: string;
    aiModelId: string | null;
    aiModelVersion: string | null;
    promptVersion: string | null;
    processingTimeMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    caseNoteIds: string[];
    preSummaryIds: string[];
    previousSummaryIds: string[];
    generatedAt: Date | null;
    createdAt: Date;
}> = {}) => ({
    id: overrides.id ?? 'summary-meta-id-1',
    contextItemId: overrides.contextItemId ?? 'context-item-id-1',
    aiModelId: 'aiModelId' in overrides ? overrides.aiModelId : 'gpt-4',
    aiModelVersion: 'aiModelVersion' in overrides ? overrides.aiModelVersion : '1.0',
    promptVersion: 'promptVersion' in overrides ? overrides.promptVersion : 'v2',
    processingTimeMs: 'processingTimeMs' in overrides ? overrides.processingTimeMs : 2500,
    inputTokens: 'inputTokens' in overrides ? overrides.inputTokens : 1000,
    outputTokens: 'outputTokens' in overrides ? overrides.outputTokens : 500,
    caseNoteIds: overrides.caseNoteIds ?? [],
    preSummaryIds: overrides.preSummaryIds ?? [],
    previousSummaryIds: overrides.previousSummaryIds ?? [],
    generatedAt: 'generatedAt' in overrides ? overrides.generatedAt : new Date('2026-01-29T10:00:00Z'),
    createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
    totalTokens: 1500,
    processingTimeSeconds: 2.5,
    hasAnyContext: false,
});

// Helper to create mock named entity
const createMockNamedEntityEntity = (overrides: Partial<{
    id: string;
    contextItemId: string;
    text: string | null;
    className: string | null;
    normalizedText: string | null;
    displayText: string | null;
    isHighConfidence: boolean;
    startOffset: number | null;
    endOffset: number | null;
    confidence: number | null;
    aiModelId: string | null;
    aiModelVersion: string | null;
    processingTimeMs: number | null;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
}> = {}) => ({
    id: overrides.id ?? 'named-entity-id-1',
    contextItemId: overrides.contextItemId ?? 'context-item-id-1',
    text: 'text' in overrides ? overrides.text : 'Aspirin',
    className: 'className' in overrides ? overrides.className : 'MEDICATION',
    normalizedText: 'normalizedText' in overrides ? overrides.normalizedText : 'acetylsalicylic acid',
    displayText: 'displayText' in overrides ? overrides.displayText : 'acetylsalicylic acid',
    isHighConfidence: 'isHighConfidence' in overrides ? overrides.isHighConfidence : true,
    startOffset: 'startOffset' in overrides ? overrides.startOffset : 10,
    endOffset: 'endOffset' in overrides ? overrides.endOffset : 17,
    confidence: 'confidence' in overrides ? overrides.confidence : 0.95,
    aiModelId: 'aiModelId' in overrides ? overrides.aiModelId : 'ner-model-1',
    aiModelVersion: 'aiModelVersion' in overrides ? overrides.aiModelVersion : '2.0',
    processingTimeMs: 'processingTimeMs' in overrides ? overrides.processingTimeMs : 50,
    metadata: 'metadata' in overrides ? overrides.metadata : null,
    createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
});

// Define enum values as constants to use in both mock and tests
const MockContextItemType = {
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

const MockContextItemSource = {
    USER: 'USER',
    AI: 'AI',
    SYSTEM: 'SYSTEM',
    TRANSCRIPTION: 'TRANSCRIPTION',
} as const;

// Mock factories - use string literals for enum values to avoid circular dependency issues
vi.mock('@arcaai/domains', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@arcaai/domains')>();

    // Define enums inline to ensure they're available
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
    };

    const ContextItemSource = {
        USER: 'USER',
        AI: 'AI',
        SYSTEM: 'SYSTEM',
        TRANSCRIPTION: 'TRANSCRIPTION',
    };

    return {
        ...actual,
        // Override enums with our mock versions
        ContextItemType,
        ContextItemSource,
        ContextItemFactory: {
            CreateContextItem: vi.fn((data) => ({
                ...data,
                id: 'new-context-item-id',
                currentVersionNumber: 1,
                qdrantSynced: false,
                isSummary: data.type === 'RAW_SUMMARY' || data.type === 'MODIFIED_SUMMARY' || data.type === 'PRE_SUMMARY',
                isFinalSummary: data.type === 'RAW_SUMMARY' || data.type === 'MODIFIED_SUMMARY',
                isPreSummary: data.type === 'PRE_SUMMARY',
                isTranscript: data.type === 'TRANSCRIPT',
                isAiGenerated: data.source === 'AI',
                requiresContent: data.type !== 'AUDIO_RECORDING' && data.type !== 'ATTACHMENT',
                createdAt: new Date(),
                updatedAt: new Date(),
            })),
            CreateRawSummary: vi.fn((tenantId, consultationId, content, dnaWritingStyleId, createdBy) => ({
                tenantId,
                consultationId,
                type: 'RAW_SUMMARY',
                source: 'AI',
                content,
                dnaWritingStyleId,
                createdBy,
                id: 'new-summary-id',
                currentVersionNumber: 1,
                qdrantSynced: false,
                isSummary: true,
                isTranscript: false,
                isAiGenerated: true,
                requiresContent: true,
                createdAt: new Date(),
                updatedAt: new Date(),
            })),
            CreateAudioRecording: vi.fn((tenantId, consultationId, createdBy) => ({
                tenantId,
                consultationId,
                type: 'AUDIO_RECORDING',
                source: 'USER',
                content: null,
                createdBy,
                id: 'new-audio-container-id',
                currentVersionNumber: 1,
                qdrantSynced: false,
                isSummary: false,
                isTranscript: false,
                isAiGenerated: false,
                requiresContent: false,
                createdAt: new Date(),
                updatedAt: new Date(),
            })),
        },
        ContextItemVersionFactory: {
            CreateInitialVersion: vi.fn((contextItem, createdBy) => ({
                id: 'new-initial-version-id',
                contextItemId: contextItem.id,
                versionNumber: 1,
                content: contextItem.content,
                contentDiff: null,
                changeReason: 'initial_creation',
                changeSummary: 'Initial version',
                changedBy: createdBy,
                changeSource: 'system',
                fieldChanges: null,
                createdAt: new Date(),
            })),
            CreateUserEditVersion: vi.fn((contextItem, versionNumber, changedBy, changeSummary, contentDiff, fieldChanges) => ({
                id: 'new-version-id',
                contextItemId: contextItem.id,
                versionNumber,
                content: contextItem.content,
                contentDiff,
                changeSummary,
                changedBy,
                changeSource: 'manual',
                fieldChanges,
                createdAt: new Date(),
            })),
        },
        AudioRecordingFactory: {
            CreateWithMetadata: vi.fn((tenantId, contextItemId, mediaId, metadata, sequenceNumber, recordedAt) => ({
                id: 'new-audio-recording-id',
                tenantId,
                contextItemId,
                mediaId,
                ...metadata,
                sequenceNumber,
                recordedAt,
                createdAt: new Date(),
            })),
        },
        SummaryMetaFactory: {
            CreateWithContext: vi.fn((tenantId, contextItemId, aiModelId, aiModelVersion, context, processingTimeMs) => ({
                id: 'new-summary-meta-id',
                tenantId,
                contextItemId,
                aiModelId,
                aiModelVersion,
                caseNoteIds: context.caseNoteIds ?? [],
                preSummaryIds: context.preSummaryIds ?? [],
                previousSummaryIds: context.previousSummaryIds ?? [],
                processingTimeMs,
                inputTokens: null,
                outputTokens: null,
                promptVersion: null,
                generatedAt: new Date(),
                createdAt: new Date(),
            })),
        },
        NamedEntityFactory: {
            CreateWithAiModel: vi.fn((tenantId, contextItemId, text, className, aiModelId, aiModelVersion, confidence, processingTimeMs, normalizedText, startOffset, endOffset, metadata) => ({
                id: 'new-named-entity-id',
                tenantId,
                contextItemId,
                text,
                className,
                aiModelId,
                aiModelVersion,
                confidence,
                processingTimeMs,
                normalizedText,
                startOffset,
                endOffset,
                metadata,
                createdAt: new Date(),
                displayText: normalizedText || text,
                isHighConfidence: (confidence ?? 0) >= 0.8,
            })),
        },
    };
});

describe('ContextService', () => {
    let service: ContextService;

    beforeEach(() => {
        vi.clearAllMocks();
        mockContextItemVersionRepository.getLatestVersionNumber.mockResolvedValue(0);

        // Default: return valid user and tenant from CLS
        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user':
                    return { id: 'user-id-1' };
                case 'tenantId':
                    return 'tenant-1';
                case 'correlationId':
                    return 'corr-123';
                case 'requestIp':
                    return '192.168.1.1';
                default:
                    return null;
            }
        });

        // Create service instance with mocks
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

    // ============================================
    // addContext Tests
    // ============================================

    describe('addContext', () => {
        it('should throw BadRequestException when tenant ID is not available', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                if (key === 'user') return { id: 'user-id-1' };
                return null;
            });

            await expect(
                service.addContext('consultation-1', {
                    type: ContextItemType.TRANSCRIPT,
                    content: 'Test',
                })
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw NotFoundException when consultation not found', async () => {
            mockConsultationRepository.findById.mockResolvedValue(null);

            await expect(
                service.addContext('non-existent', {
                    type: ContextItemType.TRANSCRIPT,
                    content: 'Test',
                })
            ).rejects.toThrow(NotFoundException);
        });

        it('should throw BadRequestException when content is missing for non-media types', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });

            await expect(
                service.addContext('consultation-1', { type: ContextItemType.TRANSCRIPT })
            ).rejects.toThrow(BadRequestException);
            await expect(
                service.addContext('consultation-1', { type: ContextItemType.TRANSCRIPT })
            ).rejects.toThrow('Content is required for non-media types');
        });

        it('should throw BadRequestException when content is empty string for non-media types', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });

            await expect(
                service.addContext('consultation-1', {
                    type: ContextItemType.TRANSCRIPT,
                    content: '',
                })
            ).rejects.toThrow(BadRequestException);
        });

        it('should allow null content for AUDIO_RECORDING type', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newContextItem = createMockContextItemEntity({
                id: 'new-audio-id',
                type: ContextItemType.AUDIO_RECORDING,
                content: null,
                requiresContent: false,
            });
            mockContextItemRepository.create.mockResolvedValue(newContextItem);

            const result = await service.addContext('consultation-1', {
                type: ContextItemType.AUDIO_RECORDING,
            });

            expect(result.id).toBe('new-audio-id');
        });

        it('should allow null content for ATTACHMENT type', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newContextItem = createMockContextItemEntity({
                id: 'new-attachment-id',
                type: ContextItemType.ATTACHMENT,
                content: null,
                requiresContent: false,
            });
            mockContextItemRepository.create.mockResolvedValue(newContextItem);

            const result = await service.addContext('consultation-1', {
                type: ContextItemType.ATTACHMENT,
            });

            expect(result.id).toBe('new-attachment-id');
        });

        it('threads extracted lab/exam text (not the filename label) into the live ContextAdded preview (TASK-342 GAP #5)', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newContextItem = createMockContextItemEntity({
                id: 'new-attachment-id',
                type: ContextItemType.ATTACHMENT,
                content: 'Lab/exam result: cbc.txt',
                requiresContent: false,
            });
            mockContextItemRepository.create.mockResolvedValue(newContextItem);

            await service.addContext('consultation-1', {
                type: ContextItemType.ATTACHMENT,
                content: 'Lab/exam result: cbc.txt',
                mediaId: 'media-1',
                metadata: { subType: 'LAB_RESULT', fileName: 'cbc.txt', extractedText: 'WBC 11.2 x10^9/L (high)' },
            });

            // GAP #5: the live-summary watcher must receive the EXTRACTED contents,
            // not the "Lab/exam result: <name>" filename label, so the file's text
            // actually reaches the running summary.
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'consultation.context.added',
                expect.objectContaining({ contentPreview: 'WBC 11.2 x10^9/L (high)' }),
            );
        });

        it('should create context item for transcript type with content', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newContextItem = createMockContextItemEntity({
                id: 'new-context-item-id',
                type: ContextItemType.TRANSCRIPT,
            });
            mockContextItemRepository.create.mockResolvedValue(newContextItem);

            const result = await service.addContext('consultation-1', {
                type: ContextItemType.TRANSCRIPT,
                content: 'Test transcription content',
            });

            expect(result.id).toBe('new-context-item-id');
            expect(mockContextItemRepository.create).toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-context-item-id',
                    data: { consultationId: 'consultation-1', type: ContextItemType.TRANSCRIPT },
                })
            );
        });

        it('should create context item for worknote type', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newContextItem = createMockContextItemEntity({
                id: 'new-worknote-id',
                type: ContextItemType.WORKNOTE,
            });
            mockContextItemRepository.create.mockResolvedValue(newContextItem);

            const result = await service.addContext('consultation-1', {
                type: ContextItemType.WORKNOTE,
                content: 'Follow up required',
            });

            expect(result.id).toBe('new-worknote-id');
        });

        it('should create context item for case note type', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newContextItem = createMockContextItemEntity({
                id: 'new-case-note-id',
                type: ContextItemType.CASE_NOTE,
            });
            mockContextItemRepository.create.mockResolvedValue(newContextItem);
            const result = await service.addContext('consultation-1', {
                type: ContextItemType.CASE_NOTE,
                content: 'Patient history notes',
            });

            expect(result.id).toBe('new-case-note-id');
        });

        it('should create context item for RAW_SUMMARY type with AI source', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newContextItem = createMockContextItemEntity({
                id: 'new-summary-id',
                type: ContextItemType.RAW_SUMMARY,
                source: ContextItemSource.AI,
                isSummary: true,
                isAiGenerated: true,
            });
            mockContextItemRepository.create.mockResolvedValue(newContextItem);
            const result = await service.addContext('consultation-1', {
                type: ContextItemType.RAW_SUMMARY,
                source: ContextItemSource.AI,
                content: 'AI generated summary',
            });

            expect(result.id).toBe('new-summary-id');
        });

        it('should create context item for MODIFIED_SUMMARY type', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newContextItem = createMockContextItemEntity({
                id: 'new-modified-summary-id',
                type: ContextItemType.MODIFIED_SUMMARY,
                source: ContextItemSource.USER,
                isSummary: true,
            });
            mockContextItemRepository.create.mockResolvedValue(newContextItem);
            const result = await service.addContext('consultation-1', {
                type: ContextItemType.MODIFIED_SUMMARY,
                source: ContextItemSource.USER,
                content: 'User modified summary',
            });

            expect(result.id).toBe('new-modified-summary-id');
        });

        it('should use default source when not provided', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newContextItem = createMockContextItemEntity({ source: ContextItemSource.USER });
            mockContextItemRepository.create.mockResolvedValue(newContextItem);
            await service.addContext('consultation-1', {
                type: ContextItemType.CASE_NOTE,
                content: 'Test note',
            });

            expect(mockContextItemRepository.create).toHaveBeenCalled();
        });

        it('should include dnaWritingStyleId when provided', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newContextItem = createMockContextItemEntity({
                dnaWritingStyleId: 'dna-style-123',
            });
            mockContextItemRepository.create.mockResolvedValue(newContextItem);
            await service.addContext('consultation-1', {
                type: ContextItemType.TRANSCRIPT,
                content: 'Test content',
                dnaWritingStyleId: 'dna-style-123',
            });

            expect(mockContextItemRepository.create).toHaveBeenCalled();
        });

        it('should handle very long content', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const longContent = 'A'.repeat(100000); // 100KB of content
            const newContextItem = createMockContextItemEntity({
                id: 'new-long-content-id',
                content: longContent,
            });
            mockContextItemRepository.create.mockResolvedValue(newContextItem);
            const result = await service.addContext('consultation-1', {
                type: ContextItemType.TRANSCRIPT,
                content: longContent,
            });

            expect(result.id).toBe('new-long-content-id');
        });

        it('should handle content with special characters', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const specialContent = '日本語テスト 🏥 <script>alert("xss")</script> "quotes" \'apostrophe\'';
            const newContextItem = createMockContextItemEntity({
                id: 'new-special-content-id',
                content: specialContent,
            });
            mockContextItemRepository.create.mockResolvedValue(newContextItem);
            const result = await service.addContext('consultation-1', {
                type: ContextItemType.CASE_NOTE,
                content: specialContent,
            });

            expect(result.id).toBe('new-special-content-id');
        });

        it('should handle user not being available in CLS', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return 'tenant-1';
                if (key === 'user') return null;
                return null;
            });
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newContextItem = createMockContextItemEntity({ id: 'new-id' });
            mockContextItemRepository.create.mockResolvedValue(newContextItem);
            const result = await service.addContext('consultation-1', {
                type: ContextItemType.TRANSCRIPT,
                content: 'Test content',
            });

            expect(result.id).toBe('new-id');
        });
    });

    // ============================================
    // updateContext Tests
    // ============================================

    describe('updateContext', () => {
        it('should throw NotFoundException when context item not found', async () => {
            mockContextItemRepository.findById.mockResolvedValue(null);

            await expect(
                service.updateContext('non-existent', { content: 'Updated' })
            ).rejects.toThrow(NotFoundException);
        });

        it('should create version snapshot and update context item', async () => {
            const existingItem = createMockContextItemEntity({
                id: 'context-item-id-1',
                content: 'Original content',
                currentVersionNumber: 1,
            });
            mockContextItemRepository.findById.mockResolvedValue(existingItem);
            mockContextItemVersionRepository.create.mockResolvedValue({});
            const updatedItem = createMockContextItemEntity({
                id: 'context-item-id-1',
                content: 'Updated content',
                currentVersionNumber: 2,
            });
            mockContextItemRepository.update.mockResolvedValue(updatedItem);
            const result = await service.updateContext('context-item-id-1', {
                content: 'Updated content',
                changeSummary: 'Fixed typo',
            });

            expect(result.id).toBe('context-item-id-1');
            expect(mockContextItemVersionRepository.create).toHaveBeenCalled();
            expect(mockContextItemVersionRepository.getLatestVersionNumber).toHaveBeenCalledWith('context-item-id-1');
            expect(existingItem.markQdrantNeedsSync).toHaveBeenCalled();
            expect(mockContextItemRepository.update).toHaveBeenCalledWith(
                'context-item-id-1',
                existingItem
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'context-item-id-1',
                })
            );
        });

        it('should update dnaWritingStyleId when provided', async () => {
            const existingItem = createMockContextItemEntity({
                dnaWritingStyleId: 'old-style-id',
            });
            mockContextItemRepository.findById.mockResolvedValue(existingItem);
            mockContextItemVersionRepository.create.mockResolvedValue({});
            mockContextItemRepository.update.mockResolvedValue(existingItem);
            await service.updateContext('context-item-id-1', {
                dnaWritingStyleId: 'new-style-id',
            });

            expect(existingItem.dnaWritingStyleId).toBe('new-style-id');
        });

        it('should set updatedBy when user is available', async () => {
            const existingItem = createMockContextItemEntity({
                content: 'Original',
                updatedBy: null,
            });
            mockContextItemRepository.findById.mockResolvedValue(existingItem);
            mockContextItemVersionRepository.create.mockResolvedValue({});
            mockContextItemRepository.update.mockResolvedValue(existingItem);
            await service.updateContext('context-item-id-1', {
                content: 'Updated',
            });

            expect(existingItem.updatedBy).toBe('user-id-1');
        });

        it('should set updatedBy to system when user is not available', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return 'tenant-1';
                if (key === 'user') return null;
                return null;
            });
            const existingItem = createMockContextItemEntity({
                content: 'Original',
                updatedBy: null,
            });
            mockContextItemRepository.findById.mockResolvedValue(existingItem);
            mockContextItemVersionRepository.create.mockResolvedValue({});
            mockContextItemRepository.update.mockResolvedValue(existingItem);
            await service.updateContext('context-item-id-1', {
                content: 'Updated',
            });

            expect(existingItem.updatedBy).toBe('system');
        });

        it('should preserve content when only updating dnaWritingStyleId', async () => {
            const existingItem = createMockContextItemEntity({
                content: 'Original content that should remain',
                dnaWritingStyleId: null,
            });
            mockContextItemRepository.findById.mockResolvedValue(existingItem);
            mockContextItemVersionRepository.create.mockResolvedValue({});
            mockContextItemRepository.update.mockResolvedValue(existingItem);
            await service.updateContext('context-item-id-1', {
                dnaWritingStyleId: 'new-style-id',
            });

            expect(existingItem.content).toBe('Original content that should remain');
            expect(existingItem.dnaWritingStyleId).toBe('new-style-id');
        });

        it('should handle update with fieldChanges metadata', async () => {
            const existingItem = createMockContextItemEntity({
                content: 'Original',
            });
            mockContextItemRepository.findById.mockResolvedValue(existingItem);
            mockContextItemVersionRepository.create.mockResolvedValue({});
            mockContextItemRepository.update.mockResolvedValue(existingItem);
            await service.updateContext('context-item-id-1', {
                content: 'Updated',
                fieldChanges: { content: { old: 'Original', new: 'Updated' } },
            });

            expect(mockContextItemVersionRepository.create).toHaveBeenCalled();
        });

        it('should use default changeSummary when not provided', async () => {
            const existingItem = createMockContextItemEntity({
                content: 'Original',
            });
            mockContextItemRepository.findById.mockResolvedValue(existingItem);
            mockContextItemVersionRepository.create.mockResolvedValue({});
            mockContextItemRepository.update.mockResolvedValue(existingItem);
            await service.updateContext('context-item-id-1', {
                content: 'Updated',
            });

            expect(mockContextItemVersionRepository.create).toHaveBeenCalled();
        });

        it('should handle multiple consecutive updates correctly', async () => {
            const existingItem = createMockContextItemEntity({
                content: 'Original',
                currentVersionNumber: 5,
            });
            mockContextItemRepository.findById.mockResolvedValue(existingItem);
            mockContextItemVersionRepository.create.mockResolvedValue({});
            mockContextItemVersionRepository.getLatestVersionNumber.mockResolvedValue(5);
            mockContextItemRepository.update.mockResolvedValue(existingItem);
            await service.updateContext('context-item-id-1', {
                content: 'Updated',
            });

            expect(existingItem.currentVersionNumber).toBe(6);
        });

        it('should use latest version number and create exactly once', async () => {
            const existingItem = createMockContextItemEntity({
                id: 'context-item-id-1',
                content: 'Original content',
                currentVersionNumber: 2,
            });

            mockContextItemRepository.findById.mockResolvedValue(existingItem);
            mockContextItemVersionRepository.create.mockResolvedValue({});
            mockContextItemVersionRepository.getLatestVersionNumber.mockResolvedValue(2);
            mockContextItemRepository.update.mockResolvedValue(existingItem);

            await service.updateContext('context-item-id-1', {
                content: 'Updated content after retry',
                changeSummary: 'Retry collision',
            });

            expect(mockContextItemVersionRepository.create).toHaveBeenCalledTimes(1);
            expect(mockContextItemVersionRepository.getLatestVersionNumber).toHaveBeenCalledWith('context-item-id-1');
            expect(mockContextItemVersionRepository.create.mock.calls[0]?.[0]?.versionNumber).toBe(3);
            expect(existingItem.currentVersionNumber).toBe(3);
        });

        it('should handle update with null content to clear it', async () => {
            const existingItem = createMockContextItemEntity({
                content: 'Original content',
            });
            mockContextItemRepository.findById.mockResolvedValue(existingItem);
            mockContextItemVersionRepository.create.mockResolvedValue({});
            mockContextItemRepository.update.mockResolvedValue(existingItem);
            await service.updateContext('context-item-id-1', {
                content: undefined,
            });

            // Content should remain unchanged when undefined
            expect(existingItem.content).toBe('Original content');
        });
    });

    // ============================================
    // deleteContext Tests (TASK-342 GAP #3)
    // ============================================

    describe('deleteContext', () => {
        it('should throw BadRequestException when tenant ID is not available', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                if (key === 'user') return { id: 'user-id-1' };
                return null;
            });

            await expect(service.deleteContext('context-item-id-1')).rejects.toThrow(BadRequestException);
        });

        it('should throw NotFoundException when context item not found', async () => {
            mockContextItemRepository.findById.mockResolvedValue(null);

            await expect(service.deleteContext('non-existent')).rejects.toThrow(NotFoundException);
            expect(mockContextItemRepository.softDelete).not.toHaveBeenCalled();
        });

        it('should throw NotFoundException when the item belongs to another tenant', async () => {
            const foreign = createMockContextItemEntity({ id: 'context-item-id-1', tenantId: 'tenant-OTHER' });
            mockContextItemRepository.findById.mockResolvedValue(foreign);

            await expect(service.deleteContext('context-item-id-1')).rejects.toThrow(NotFoundException);
            expect(mockContextItemRepository.softDelete).not.toHaveBeenCalled();
        });

        it('soft-deletes the item and broadcasts ResourceDeleted', async () => {
            const existing = createMockContextItemEntity({
                id: 'context-item-id-1',
                consultationId: 'consultation-1',
                type: 'CASE_NOTE',
            });
            mockContextItemRepository.findById.mockResolvedValue(existing);
            mockContextItemRepository.softDelete.mockResolvedValue(existing);

            await service.deleteContext('context-item-id-1');

            expect(mockContextItemRepository.softDelete).toHaveBeenCalledWith('context-item-id-1', 'user-id-1');
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'context-item-id-1',
                    data: expect.objectContaining({ consultationId: 'consultation-1', type: 'CASE_NOTE' }),
                })
            );
        });
    });

    // ============================================
    // addAudioRecording Tests
    // ============================================

    describe('addAudioRecording', () => {
        it('should throw BadRequestException when tenant ID is not available', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                return null;
            });

            await expect(
                service.addAudioRecording('consultation-1', { mediaId: 'media-uuid-123' })
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw NotFoundException when consultation not found', async () => {
            mockConsultationRepository.findById.mockResolvedValue(null);

            await expect(
                service.addAudioRecording('non-existent', { mediaId: 'media-uuid-123' })
            ).rejects.toThrow(NotFoundException);
        });

        it('should create audio recording and container', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            mockContextItemRepository.findAudioRecordings.mockResolvedValue([]);
            const newContainer = createMockContextItemEntity({
                id: 'new-audio-container-id',
                type: ContextItemType.AUDIO_RECORDING,
            });
            mockContextItemRepository.create.mockResolvedValue(newContainer);
            mockAudioRecordingRepository.getNextSequenceNumber.mockResolvedValue(1);
            mockAudioRecordingRepository.create.mockResolvedValue({});
            mockContextItemRepository.findWithAudioRecordings.mockResolvedValue({
                ...newContainer,
                AudioRecordings: [createMockAudioRecordingEntity()],
            });

            const result = await service.addAudioRecording('consultation-1', {
                mediaId: 'media-uuid-123',
                duration: 180000,
                format: 'mp3',
            });

            expect(result.id).toBe('new-audio-container-id');
            expect(mockAudioRecordingRepository.create).toHaveBeenCalled();
        });

        it('should emit ResourceCreated event after creating audio recording', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            mockContextItemRepository.findAudioRecordings.mockResolvedValue([]);
            const newContainer = createMockContextItemEntity({
                id: 'new-audio-container-id',
                type: ContextItemType.AUDIO_RECORDING,
            });
            mockContextItemRepository.create.mockResolvedValue(newContainer);
            mockAudioRecordingRepository.getNextSequenceNumber.mockResolvedValue(1);
            mockAudioRecordingRepository.create.mockResolvedValue({ id: 'audio-rec-id', createdAt: new Date('2026-01-29T10:00:00Z') });
            mockContextItemRepository.findWithAudioRecordings.mockResolvedValue({
                ...newContainer,
                AudioRecordings: [createMockAudioRecordingEntity()],
            });

            await service.addAudioRecording('consultation-1', {
                mediaId: 'media-uuid-123',
                duration: 180000,
                format: 'mp3',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'audio-rec-id',
                    data: expect.objectContaining({
                        consultationId: 'consultation-1',
                        type: 'AUDIO_RECORDING',
                        mediaId: 'media-uuid-123',
                    }),
                })
            );
        });

        it('should use existing audio container if present', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const existingContainer = createMockContextItemEntity({
                id: 'existing-container-id',
                type: ContextItemType.AUDIO_RECORDING,
            });
            mockContextItemRepository.findAudioRecordings.mockResolvedValue([existingContainer]);
            mockAudioRecordingRepository.getNextSequenceNumber.mockResolvedValue(2);
            mockAudioRecordingRepository.create.mockResolvedValue({});
            mockContextItemRepository.findWithAudioRecordings.mockResolvedValue({
                ...existingContainer,
                AudioRecordings: [
                    createMockAudioRecordingEntity({ sequenceNumber: 1 }),
                    createMockAudioRecordingEntity({ id: 'audio-2', sequenceNumber: 2 }),
                ],
            });

            const result = await service.addAudioRecording('consultation-1', {
                mediaId: 'media-uuid-456',
            });

            expect(result.id).toBe('existing-container-id');
            // Should not create new container
            expect(mockContextItemRepository.create).not.toHaveBeenCalled();
        });
    });

    // ============================================
    // getAudioRecordings Tests
    // ============================================

    describe('getAudioRecordings', () => {
        it('should return audio recordings for consultation', async () => {
            const container = createMockContextItemEntity({
                type: ContextItemType.AUDIO_RECORDING,
            });
            mockContextItemRepository.findAudioRecordings.mockResolvedValue([container]);
            mockAudioRecordingRepository.findByContextItem.mockResolvedValue([
                createMockAudioRecordingEntity({ sequenceNumber: 1 }),
                createMockAudioRecordingEntity({ id: 'audio-2', sequenceNumber: 2 }),
            ]);

            const result = await service.getAudioRecordings('consultation-1');

            expect(result).toHaveLength(2);
            expect(result[0].sequenceNumber).toBe(1);
            expect(result[1].sequenceNumber).toBe(2);
        });

        it('should return empty array when no audio recordings exist', async () => {
            mockContextItemRepository.findAudioRecordings.mockResolvedValue([]);

            const result = await service.getAudioRecordings('consultation-1');

            expect(result).toHaveLength(0);
        });

        it('should aggregate recordings from multiple containers', async () => {
            const container1 = createMockContextItemEntity({
                id: 'container-1',
                type: ContextItemType.AUDIO_RECORDING,
            });
            const container2 = createMockContextItemEntity({
                id: 'container-2',
                type: ContextItemType.AUDIO_RECORDING,
            });
            mockContextItemRepository.findAudioRecordings.mockResolvedValue([container1, container2]);
            mockAudioRecordingRepository.findByContextItem
                .mockResolvedValueOnce([createMockAudioRecordingEntity({ id: 'audio-1', sequenceNumber: 1 })])
                .mockResolvedValueOnce([createMockAudioRecordingEntity({ id: 'audio-2', sequenceNumber: 1 })]);

            const result = await service.getAudioRecordings('consultation-1');

            expect(result).toHaveLength(2);
            expect(mockAudioRecordingRepository.findByContextItem).toHaveBeenCalledTimes(2);
        });

        it('should handle container with no recordings', async () => {
            const container = createMockContextItemEntity({
                type: ContextItemType.AUDIO_RECORDING,
            });
            mockContextItemRepository.findAudioRecordings.mockResolvedValue([container]);
            mockAudioRecordingRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getAudioRecordings('consultation-1');

            expect(result).toHaveLength(0);
        });
    });

    // ============================================
    // addRawSummary Tests
    // ============================================

    describe('addRawSummary', () => {
        it('should throw BadRequestException when tenant ID is not available', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                return null;
            });

            await expect(
                service.addRawSummary('consultation-1', { content: 'Summary text' })
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw NotFoundException when consultation not found', async () => {
            mockConsultationRepository.findById.mockResolvedValue(null);

            await expect(
                service.addRawSummary('non-existent', { content: 'Summary text' })
            ).rejects.toThrow(NotFoundException);
        });

        it('should create raw summary with metadata', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newSummary = createMockContextItemEntity({
                id: 'new-summary-id',
                type: ContextItemType.RAW_SUMMARY,
                source: ContextItemSource.AI,
                isSummary: true,
            });
            mockContextItemRepository.create.mockResolvedValue(newSummary);
            mockSummaryMetaRepository.create.mockResolvedValue({});
            mockContextItemRepository.findWithSummaryMeta.mockResolvedValue({
                ...newSummary,
                SummaryMeta: createMockSummaryMetaEntity(),
            });

            const result = await service.addRawSummary('consultation-1', {
                content: 'AI generated summary',
                aiModelId: 'gpt-4',
                aiModelVersion: '1.0',
                processingTimeMs: 2500,
                caseNoteIds: ['cn-1', 'cn-2'],
            });

            expect(result.id).toBe('new-summary-id');
            expect(mockSummaryMetaRepository.create).toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    data: { consultationId: 'consultation-1', type: ContextItemType.RAW_SUMMARY },
                })
            );
        });

        // TASK-329 (P6) — cacheHit/qualityScore must thread through to the persisted SummaryMeta
        it('should persist cacheHit and qualityScore on the summary metadata', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newSummary = createMockContextItemEntity({
                id: 'new-summary-id',
                type: ContextItemType.RAW_SUMMARY,
                source: ContextItemSource.AI,
                isSummary: true,
            });
            mockContextItemRepository.create.mockResolvedValue(newSummary);
            mockSummaryMetaRepository.create.mockResolvedValue({});
            mockContextItemRepository.findWithSummaryMeta.mockResolvedValue({
                ...newSummary,
                SummaryMeta: createMockSummaryMetaEntity(),
            });

            await service.addRawSummary('consultation-1', {
                content: 'AI generated summary',
                aiModelId: 'gpt-4',
                cacheHit: true,
                qualityScore: 0.91,
            });

            expect(mockSummaryMetaRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({ cacheHit: true, qualityScore: 0.91 })
            );
        });
    });

    // ============================================
    // getSummaryMeta Tests
    // ============================================

    describe('getSummaryMeta', () => {
        it('should return summary meta when found', async () => {
            const summaryMeta = createMockSummaryMetaEntity();
            mockSummaryMetaRepository.findByContextItem.mockResolvedValue(summaryMeta);

            const result = await service.getSummaryMeta('context-item-id-1');

            expect(result).not.toBeNull();
            expect(result!.aiModelId).toBe('gpt-4');
        });

        it('should return null when summary meta not found', async () => {
            mockSummaryMetaRepository.findByContextItem.mockResolvedValue(null);

            const result = await service.getSummaryMeta('context-item-id-1');

            expect(result).toBeNull();
        });

        it('should return summary meta with all context IDs', async () => {
            const summaryMeta = createMockSummaryMetaEntity({
                caseNoteIds: ['cn-1', 'cn-2'],
                preSummaryIds: ['ps-1'],
                previousSummaryIds: ['prev-1', 'prev-2'],
            });
            mockSummaryMetaRepository.findByContextItem.mockResolvedValue(summaryMeta);

            const result = await service.getSummaryMeta('context-item-id-1');

            expect(result).not.toBeNull();
            expect(result!.caseNoteIds).toEqual(['cn-1', 'cn-2']);
            expect(result!.preSummaryIds).toEqual(['ps-1']);
            expect(result!.previousSummaryIds).toEqual(['prev-1', 'prev-2']);
        });

        it('should return summary meta with token information', async () => {
            const summaryMeta = createMockSummaryMetaEntity({
                inputTokens: 1500,
                outputTokens: 800,
            });
            mockSummaryMetaRepository.findByContextItem.mockResolvedValue(summaryMeta);

            const result = await service.getSummaryMeta('context-item-id-1');

            expect(result).not.toBeNull();
            expect(result!.inputTokens).toBe(1500);
            expect(result!.outputTokens).toBe(800);
            expect(result!.totalTokens).toBe(1500); // From mock default
        });
    });

    // ============================================
    // addNamedEntities Tests
    // ============================================

    describe('addNamedEntities', () => {
        it('should throw BadRequestException when tenant ID is not available', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                return null;
            });

            await expect(
                service.addNamedEntities('context-item-id-1', {
                    entities: [{ text: 'Aspirin', className: 'MEDICATION' }],
                })
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw NotFoundException when context item not found', async () => {
            mockContextItemRepository.findById.mockResolvedValue(null);

            await expect(
                service.addNamedEntities('non-existent', {
                    entities: [{ text: 'Aspirin', className: 'MEDICATION' }],
                })
            ).rejects.toThrow(NotFoundException);
        });

        it('should create named entities', async () => {
            mockContextItemRepository.findById.mockResolvedValue(createMockContextItemEntity());
            mockNamedEntityRepository.create.mockResolvedValue(createMockNamedEntityEntity());

            const result = await service.addNamedEntities('context-item-id-1', {
                entities: [
                    { text: 'Aspirin', className: 'MEDICATION', confidence: 0.95 },
                    { text: 'Headache', className: 'CONDITION', confidence: 0.88 },
                ],
                aiModelId: 'ner-model-1',
                aiModelVersion: '2.0',
            });

            expect(result).toHaveLength(2);
            expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(2);
        });

        it('should handle empty entities array', async () => {
            mockContextItemRepository.findById.mockResolvedValue(createMockContextItemEntity());

            const result = await service.addNamedEntities('context-item-id-1', {
                entities: [],
            });

            expect(result).toHaveLength(0);
            expect(mockNamedEntityRepository.create).not.toHaveBeenCalled();
        });

        it('should create entities with all optional fields', async () => {
            mockContextItemRepository.findById.mockResolvedValue(createMockContextItemEntity());
            mockNamedEntityRepository.create.mockResolvedValue(createMockNamedEntityEntity());

            const result = await service.addNamedEntities('context-item-id-1', {
                entities: [
                    {
                        text: 'Aspirin',
                        className: 'MEDICATION',
                        confidence: 0.95,
                        normalizedText: 'acetylsalicylic acid',
                        startOffset: 10,
                        endOffset: 17,
                        metadata: { icd10: 'N02.0', dosage: '100mg' },
                    },
                ],
                aiModelId: 'ner-model-1',
                aiModelVersion: '2.0',
                processingTimeMs: 150,
            });

            expect(result).toHaveLength(1);
            expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(1);
        });

        it('should create entities without AI model info', async () => {
            mockContextItemRepository.findById.mockResolvedValue(createMockContextItemEntity());
            mockNamedEntityRepository.create.mockResolvedValue(createMockNamedEntityEntity());

            const result = await service.addNamedEntities('context-item-id-1', {
                entities: [
                    { text: 'Aspirin', className: 'MEDICATION' },
                ],
            });

            expect(result).toHaveLength(1);
        });

        it('should handle entities with low confidence scores', async () => {
            mockContextItemRepository.findById.mockResolvedValue(createMockContextItemEntity());
            mockNamedEntityRepository.create.mockResolvedValue(
                createMockNamedEntityEntity({ confidence: 0.35, isHighConfidence: false })
            );

            const result = await service.addNamedEntities('context-item-id-1', {
                entities: [
                    { text: 'Possible medication', className: 'MEDICATION', confidence: 0.35 },
                ],
            });

            expect(result).toHaveLength(1);
        });

        it('should handle entities with different class names', async () => {
            mockContextItemRepository.findById.mockResolvedValue(createMockContextItemEntity());
            mockNamedEntityRepository.create.mockResolvedValue(createMockNamedEntityEntity());

            const result = await service.addNamedEntities('context-item-id-1', {
                entities: [
                    { text: 'Aspirin', className: 'MEDICATION' },
                    { text: 'Headache', className: 'CONDITION' },
                    { text: 'MRI', className: 'PROCEDURE' },
                    { text: 'Left arm', className: 'ANATOMY' },
                ],
            });

            expect(result).toHaveLength(4);
            expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(4);
        });

        it('should emit ResourceCreated event after creating named entities', async () => {
            mockContextItemRepository.findById.mockResolvedValue(createMockContextItemEntity());
            mockNamedEntityRepository.create.mockResolvedValue(createMockNamedEntityEntity());

            await service.addNamedEntities('context-item-id-1', {
                entities: [
                    { text: 'Aspirin', className: 'MEDICATION', confidence: 0.95 },
                    { text: 'Headache', className: 'CONDITION', confidence: 0.88 },
                ],
                aiModelId: 'ner-model-1',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'context-item-id-1',
                    data: expect.objectContaining({
                        contextItemId: 'context-item-id-1',
                        entityCount: 2,
                        type: 'NAMED_ENTITY',
                    }),
                })
            );
        });

        it('should not emit event when entities array is empty', async () => {
            mockContextItemRepository.findById.mockResolvedValue(createMockContextItemEntity());

            await service.addNamedEntities('context-item-id-1', {
                entities: [],
            });

            expect(mockEventEmitter.emit).not.toHaveBeenCalled();
        });
    });

    // ============================================
    // getNamedEntities Tests
    // ============================================

    describe('getNamedEntities', () => {
        it('should return named entities for context item', async () => {
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([
                createMockNamedEntityEntity({ text: 'Aspirin', className: 'MEDICATION' }),
                createMockNamedEntityEntity({ id: 'ne-2', text: 'Headache', className: 'CONDITION' }),
            ]);

            const result = await service.getNamedEntities('context-item-id-1');

            expect(result).toHaveLength(2);
            expect(result[0].text).toBe('Aspirin');
            expect(result[1].className).toBe('CONDITION');
        });

        it('should return empty array when no named entities exist', async () => {
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getNamedEntities('context-item-id-1');

            expect(result).toHaveLength(0);
        });

        it('should return entities with all metadata', async () => {
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([
                createMockNamedEntityEntity({
                    text: 'Aspirin',
                    className: 'MEDICATION',
                    normalizedText: 'acetylsalicylic acid',
                    startOffset: 10,
                    endOffset: 17,
                    confidence: 0.95,
                }),
            ]);

            const result = await service.getNamedEntities('context-item-id-1');

            expect(result).toHaveLength(1);
            expect(result[0].normalizedText).toBe('acetylsalicylic acid');
            expect(result[0].startOffset).toBe(10);
            expect(result[0].endOffset).toBe(17);
            expect(result[0].confidence).toBe(0.95);
        });
    });

    // ============================================
    // getNamedEntitiesByClass Tests
    // ============================================

    describe('getNamedEntitiesByClass', () => {
        it('should return named entities filtered by class', async () => {
            mockNamedEntityRepository.findByClassName.mockResolvedValue([
                createMockNamedEntityEntity({ text: 'Aspirin', className: 'MEDICATION' }),
                createMockNamedEntityEntity({ id: 'ne-2', text: 'Ibuprofen', className: 'MEDICATION' }),
            ]);

            const result = await service.getNamedEntitiesByClass('context-item-id-1', 'MEDICATION');

            expect(result).toHaveLength(2);
            expect(result.every(e => e.className === 'MEDICATION')).toBe(true);
        });

        it('should return empty array when no entities match class', async () => {
            mockNamedEntityRepository.findByClassName.mockResolvedValue([]);

            const result = await service.getNamedEntitiesByClass('context-item-id-1', 'UNKNOWN_CLASS');

            expect(result).toHaveLength(0);
        });

        it('should filter by CONDITION class', async () => {
            mockNamedEntityRepository.findByClassName.mockResolvedValue([
                createMockNamedEntityEntity({ text: 'Headache', className: 'CONDITION' }),
                createMockNamedEntityEntity({ id: 'ne-2', text: 'Migraine', className: 'CONDITION' }),
            ]);

            const result = await service.getNamedEntitiesByClass('context-item-id-1', 'CONDITION');

            expect(result).toHaveLength(2);
            expect(result.every(e => e.className === 'CONDITION')).toBe(true);
        });

        it('should filter by PROCEDURE class', async () => {
            mockNamedEntityRepository.findByClassName.mockResolvedValue([
                createMockNamedEntityEntity({ text: 'MRI', className: 'PROCEDURE' }),
            ]);

            const result = await service.getNamedEntitiesByClass('context-item-id-1', 'PROCEDURE');

            expect(result).toHaveLength(1);
            expect(result[0].className).toBe('PROCEDURE');
        });

        it('should filter by ANATOMY class', async () => {
            mockNamedEntityRepository.findByClassName.mockResolvedValue([
                createMockNamedEntityEntity({ text: 'Left arm', className: 'ANATOMY' }),
            ]);

            const result = await service.getNamedEntitiesByClass('context-item-id-1', 'ANATOMY');

            expect(result).toHaveLength(1);
            expect(result[0].className).toBe('ANATOMY');
        });
    });

    // ============================================
    // getVersionHistory Tests
    // ============================================

    describe('getVersionHistory', () => {
        it('should return version history for context item', async () => {
            const versions = [
                createMockContextItemVersionEntity({ versionNumber: 2 }),
                createMockContextItemVersionEntity({ id: 'v-1', versionNumber: 1 }),
            ];
            mockContextItemVersionRepository.getVersionHistory.mockResolvedValue(versions);

            const result = await service.getVersionHistory('context-item-id-1');

            expect(result).toHaveLength(2);
            expect(mockContextItemVersionRepository.getVersionHistory).toHaveBeenCalledWith(
                'context-item-id-1'
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { contextItemId: 'context-item-id-1', versionCount: 2 },
                })
            );
        });

        it('should return empty array when no versions exist', async () => {
            mockContextItemVersionRepository.getVersionHistory.mockResolvedValue([]);

            const result = await service.getVersionHistory('context-item-id-1');

            expect(result).toHaveLength(0);
        });
    });

    // ============================================
    // getVersion Tests
    // ============================================

    describe('getVersion', () => {
        it('should return null when version not found', async () => {
            mockContextItemVersionRepository.getVersion.mockResolvedValue(null);

            const result = await service.getVersion('context-item-id-1', 99);

            expect(result).toBeNull();
        });

        it('should return specific version when found', async () => {
            const version = createMockContextItemVersionEntity({ versionNumber: 2 });
            mockContextItemVersionRepository.getVersion.mockResolvedValue(version);

            const result = await service.getVersion('context-item-id-1', 2);

            expect(result).not.toBeNull();
            expect(result?.versionNumber).toBe(2);
        });
    });

    // ============================================
    // getContextItems Tests
    // ============================================

    describe('getContextItems', () => {
        it('should return context items for consultation', async () => {
            const items = [
                createMockContextItemEntity({ type: ContextItemType.TRANSCRIPT }),
                createMockContextItemEntity({ id: 'item-2', type: ContextItemType.CASE_NOTE }),
            ];
            mockContextItemRepository.findByConsultation.mockResolvedValue(items);

            const result = await service.getContextItems('consultation-1');

            expect(result).toHaveLength(2);
            expect(mockContextItemRepository.findByConsultation).toHaveBeenCalledWith(
                'consultation-1',
                undefined
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { consultationId: 'consultation-1', count: 2 },
                })
            );
        });

        it('should pass filters to repository', async () => {
            mockContextItemRepository.findByConsultation.mockResolvedValue([]);

            await service.getContextItems('consultation-1', { type: ContextItemType.TRANSCRIPT });

            expect(mockContextItemRepository.findByConsultation).toHaveBeenCalledWith(
                'consultation-1',
                { type: ContextItemType.TRANSCRIPT }
            );
        });
    });

    // ============================================
    // getSharedContext Tests
    // ============================================

    describe('getSharedContext', () => {
        const mockConsultation = {
            id: 'consultation-1',
            tenantId: 'tenant-1',
            patientId: 'patient-1',
            appointmentDate: new Date('2026-02-17'),
        };

        it('should return shared context combining chain + same-day strategies', async () => {
            mockConsultationRepository.findById.mockResolvedValue(mockConsultation);
            const chain = [
                { id: 'parent-id', tenantId: 'tenant-1' },
                { id: 'consultation-1', tenantId: 'tenant-1' },
            ];
            mockConsultationRepository.findConsultationChain.mockResolvedValue(chain);
            // Same-day returns chain consultations plus an unlinked one from another department
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                { id: 'parent-id', tenantId: 'tenant-1' },
                { id: 'consultation-1', tenantId: 'tenant-1' },
                { id: 'unlinked-dept-b', tenantId: 'tenant-1' },
            ]);
            const sharedItems = [
                createMockContextItemEntity({ consultationId: 'parent-id' }),
                createMockContextItemEntity({ id: 'item-2', consultationId: 'consultation-1' }),
                createMockContextItemEntity({ id: 'item-3', consultationId: 'unlinked-dept-b' }),
            ];
            mockContextItemRepository.findSharedContext.mockResolvedValue(sharedItems);

            const result = await service.getSharedContext('consultation-1');

            expect(result).toHaveLength(3);
            expect(mockConsultationRepository.findById).toHaveBeenCalledWith('consultation-1');
            expect(mockConsultationRepository.findConsultationChain).toHaveBeenCalledWith('consultation-1');
            expect(mockConsultationRepository.findByPatientAndDate).toHaveBeenCalledWith(
                'tenant-1',
                'patient-1',
                mockConsultation.appointmentDate,
            );
            // Should pass deduplicated IDs to findSharedContext
            const passedIds = mockContextItemRepository.findSharedContext.mock.calls[0][0] as string[];
            expect(passedIds).toContain('parent-id');
            expect(passedIds).toContain('consultation-1');
            expect(passedIds).toContain('unlinked-dept-b');
            expect(new Set(passedIds).size).toBe(passedIds.length); // no duplicates
        });

        it('should include unlinked same-day consultations (date-based strategy)', async () => {
            mockConsultationRepository.findById.mockResolvedValue(mockConsultation);
            // Chain has only the current consultation (no parent link)
            mockConsultationRepository.findConsultationChain.mockResolvedValue([
                { id: 'consultation-1', tenantId: 'tenant-1' },
            ]);
            // Same-day has a consultation from Doctor B in another department
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                { id: 'consultation-1', tenantId: 'tenant-1' },
                { id: 'doctor-b-consultation', tenantId: 'tenant-1' },
            ]);
            const sharedItems = [
                createMockContextItemEntity({ consultationId: 'consultation-1' }),
                createMockContextItemEntity({ id: 'item-b', consultationId: 'doctor-b-consultation' }),
            ];
            mockContextItemRepository.findSharedContext.mockResolvedValue(sharedItems);

            const result = await service.getSharedContext('consultation-1');

            expect(result).toHaveLength(2);
            const passedIds = mockContextItemRepository.findSharedContext.mock.calls[0][0] as string[];
            expect(passedIds).toContain('consultation-1');
            expect(passedIds).toContain('doctor-b-consultation');
        });

        it('should return empty array when consultation not found', async () => {
            mockConsultationRepository.findById.mockResolvedValue(null);

            const result = await service.getSharedContext('non-existent');

            expect(result).toHaveLength(0);
            expect(mockConsultationRepository.findConsultationChain).not.toHaveBeenCalled();
            expect(mockConsultationRepository.findByPatientAndDate).not.toHaveBeenCalled();
            expect(mockContextItemRepository.findSharedContext).not.toHaveBeenCalled();
        });

        it('should still find items when chain is empty but date-based returns consultations', async () => {
            mockConsultationRepository.findById.mockResolvedValue(mockConsultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                { id: 'consultation-1', tenantId: 'tenant-1' },
                { id: 'other-dept', tenantId: 'tenant-1' },
            ]);
            const items = [
                createMockContextItemEntity({ consultationId: 'other-dept' }),
            ];
            mockContextItemRepository.findSharedContext.mockResolvedValue(items);

            const result = await service.getSharedContext('consultation-1');

            expect(result).toHaveLength(1);
            const passedIds = mockContextItemRepository.findSharedContext.mock.calls[0][0] as string[];
            expect(passedIds).toContain('consultation-1');
            expect(passedIds).toContain('other-dept');
        });

        it('should broadcast SysEvent with correct merged counts', async () => {
            mockConsultationRepository.findById.mockResolvedValue(mockConsultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([
                { id: 'consultation-1', tenantId: 'tenant-1' },
            ]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                { id: 'consultation-1', tenantId: 'tenant-1' },
                { id: 'other-dept', tenantId: 'tenant-1' },
            ]);
            const items = [
                createMockContextItemEntity({ consultationId: 'consultation-1' }),
                createMockContextItemEntity({ id: 'item-2', consultationId: 'other-dept' }),
                createMockContextItemEntity({ id: 'item-3', consultationId: 'other-dept' }),
            ];
            mockContextItemRepository.findSharedContext.mockResolvedValue(items);

            await service.getSharedContext('consultation-1');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    data: expect.objectContaining({
                        consultationId: 'consultation-1',
                        sharedFromCount: 2,
                        itemCount: 3,
                    }),
                }),
            );
        });

        it('should deduplicate IDs when chain and date strategies overlap', async () => {
            mockConsultationRepository.findById.mockResolvedValue(mockConsultation);
            // Both strategies return the same set of consultations
            const sameConsultations = [
                { id: 'parent-id', tenantId: 'tenant-1' },
                { id: 'consultation-1', tenantId: 'tenant-1' },
            ];
            mockConsultationRepository.findConsultationChain.mockResolvedValue(sameConsultations);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue(sameConsultations);
            mockContextItemRepository.findSharedContext.mockResolvedValue([]);

            await service.getSharedContext('consultation-1');

            const passedIds = mockContextItemRepository.findSharedContext.mock.calls[0][0] as string[];
            expect(passedIds).toHaveLength(2);
            expect(new Set(passedIds).size).toBe(2);
        });
    });

    // ============================================
    // getTranscriptions Tests
    // ============================================

    describe('getTranscriptions', () => {
        it('should return transcriptions for consultation', async () => {
            const transcriptions = [
                createMockContextItemEntity({ type: ContextItemType.TRANSCRIPT, isTranscript: true }),
            ];
            mockContextItemRepository.findTranscripts.mockResolvedValue(transcriptions);

            const result = await service.getTranscriptions('consultation-1');

            expect(result).toHaveLength(1);
            expect(result[0].isTranscript).toBe(true);
            expect(mockContextItemRepository.findTranscripts).toHaveBeenCalledWith(
                'consultation-1'
            );
        });
    });

    // ============================================
    // getTranscripts Tests
    // ============================================

    describe('getTranscripts', () => {
        it('should return transcripts (alias for getTranscriptions)', async () => {
            const transcripts = [
                createMockContextItemEntity({ type: ContextItemType.TRANSCRIPT }),
            ];
            mockContextItemRepository.findTranscripts.mockResolvedValue(transcripts);

            const result = await service.getTranscripts('consultation-1');

            expect(result).toHaveLength(1);
        });
    });

    // ============================================
    // getCaseNotes Tests
    // ============================================

    describe('getCaseNotes', () => {
        it('should return case notes for consultation', async () => {
            const caseNotes = [createMockContextItemEntity({ type: ContextItemType.CASE_NOTE })];
            mockContextItemRepository.findCaseNotes.mockResolvedValue(caseNotes);

            const result = await service.getCaseNotes('consultation-1');

            expect(result).toHaveLength(1);
            expect(mockContextItemRepository.findCaseNotes).toHaveBeenCalledWith('consultation-1');
        });
    });

    // ============================================
    // getWorknotes Tests
    // ============================================

    describe('getWorknotes', () => {
        it('should return worknotes for consultation', async () => {
            const worknotes = [createMockContextItemEntity({ type: ContextItemType.WORKNOTE })];
            mockContextItemRepository.findWorknotes.mockResolvedValue(worknotes);

            const result = await service.getWorknotes('consultation-1');

            expect(result).toHaveLength(1);
            expect(mockContextItemRepository.findWorknotes).toHaveBeenCalledWith('consultation-1');
        });
    });

    // ============================================
    // getSummaries Tests
    // ============================================

    describe('getSummaries', () => {
        it('should return summaries for consultation', async () => {
            const summaries = [
                createMockContextItemEntity({ type: ContextItemType.RAW_SUMMARY, isSummary: true }),
                createMockContextItemEntity({ id: 'item-2', type: ContextItemType.MODIFIED_SUMMARY, isSummary: true }),
            ];
            mockContextItemRepository.findSummaries.mockResolvedValue(summaries);

            const result = await service.getSummaries('consultation-1');

            expect(result).toHaveLength(2);
            expect(mockContextItemRepository.findSummaries).toHaveBeenCalledWith('consultation-1');
        });
    });

    // ============================================
    // getContextItemWithRelations Tests
    // ============================================

    describe('getContextItemWithRelations', () => {
        it('should return null when context item not found', async () => {
            mockContextItemRepository.findWithAllRelations.mockResolvedValue(null);

            const result = await service.getContextItemWithRelations('non-existent');

            expect(result).toBeNull();
        });

        it('should return context item with all relations when found', async () => {
            const itemWithRelations = {
                ...createMockContextItemEntity(),
                AudioRecordings: [createMockAudioRecordingEntity()],
                SummaryMeta: createMockSummaryMetaEntity(),
                NamedEntities: [createMockNamedEntityEntity()],
            };
            mockContextItemRepository.findWithAllRelations.mockResolvedValue(itemWithRelations);

            const result = await service.getContextItemWithRelations('context-item-id-1');

            expect(result).not.toBeNull();
            expect(result?.id).toBe('context-item-id-1');
        });
    });

    // ============================================
    // Convenience Methods Tests
    // ============================================

    describe('addTranscript', () => {
        it('should create transcript context item', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newTranscript = createMockContextItemEntity({
                id: 'new-transcript-id',
                type: 'TRANSCRIPT' as any,
                source: 'TRANSCRIPTION' as any,
            });
            mockContextItemRepository.create.mockResolvedValue(newTranscript);
            const result = await service.addTranscript('consultation-1', 'Transcript content');

            expect(result.id).toBe('new-transcript-id');
        });
    });

    describe('addTranscription', () => {
        it('should create transcription (alias for addTranscript)', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newTranscription = createMockContextItemEntity({
                id: 'new-transcription-id',
                type: 'TRANSCRIPT' as any,
            });
            mockContextItemRepository.create.mockResolvedValue(newTranscription);
            const result = await service.addTranscription('consultation-1', 'Transcription content');

            expect(result.id).toBe('new-transcription-id');
        });
    });

    describe('addCaseNote', () => {
        it('should create case note context item', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newCaseNote = createMockContextItemEntity({
                id: 'new-case-note-id',
                type: 'CASE_NOTE' as any,
            });
            mockContextItemRepository.create.mockResolvedValue(newCaseNote);
            const result = await service.addCaseNote('consultation-1', 'Case note content');

            expect(result.id).toBe('new-case-note-id');
        });
    });

    describe('addWorknote', () => {
        it('should create worknote context item', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newWorknote = createMockContextItemEntity({
                id: 'new-worknote-id',
                type: 'WORKNOTE' as any,
            });
            mockContextItemRepository.create.mockResolvedValue(newWorknote);
            const result = await service.addWorknote('consultation-1', 'Worknote content');

            expect(result.id).toBe('new-worknote-id');
        });
    });

    // ============================================
    // PRE_SUMMARY Tests
    // ============================================

    describe('addPreSummary', () => {
        it('should create pre-summary context item', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newPreSummary = createMockContextItemEntity({
                id: 'new-pre-summary-id',
                type: 'PRE_SUMMARY' as any,
                source: 'AI' as any,
                isSummary: true,
                isPreSummary: true,
                isFinalSummary: false,
                isAiGenerated: true,
            });
            mockContextItemRepository.create.mockResolvedValue(newPreSummary);
            const result = await service.addPreSummary('consultation-1', 'Pre-summary content');

            expect(result.id).toBe('new-pre-summary-id');
            expect(result.isSummary).toBe(true);
            expect(result.isPreSummary).toBe(true);
            expect(result.isFinalSummary).toBe(false);
        });

        it('should create pre-summary with dnaWritingStyleId', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newPreSummary = createMockContextItemEntity({
                id: 'new-pre-summary-id',
                type: 'PRE_SUMMARY' as any,
                source: 'AI' as any,
                dnaWritingStyleId: 'dna-style-123',
                isSummary: true,
                isPreSummary: true,
                isFinalSummary: false,
            });
            mockContextItemRepository.create.mockResolvedValue(newPreSummary);
            const result = await service.addPreSummary('consultation-1', 'Pre-summary content', 'dna-style-123');

            expect(result.id).toBe('new-pre-summary-id');
            expect(result.dnaWritingStyleId).toBe('dna-style-123');
        });
    });

    describe('getPreSummaries', () => {
        it('should return pre-summaries for consultation', async () => {
            const preSummaries = [
                createMockContextItemEntity({
                    id: 'pre-summary-1',
                    type: 'PRE_SUMMARY' as any,
                    source: 'AI' as any,
                    isSummary: true,
                    isPreSummary: true,
                    isFinalSummary: false,
                }),
                createMockContextItemEntity({
                    id: 'pre-summary-2',
                    type: 'PRE_SUMMARY' as any,
                    source: 'AI' as any,
                    isSummary: true,
                    isPreSummary: true,
                    isFinalSummary: false,
                }),
            ];
            mockContextItemRepository.findPreSummaries.mockResolvedValue(preSummaries);

            const result = await service.getPreSummaries('consultation-1');

            expect(result).toHaveLength(2);
            expect(result[0].isPreSummary).toBe(true);
            expect(result[1].isPreSummary).toBe(true);
            expect(mockContextItemRepository.findPreSummaries).toHaveBeenCalledWith('consultation-1');
        });

        it('should return empty array when no pre-summaries exist', async () => {
            mockContextItemRepository.findPreSummaries.mockResolvedValue([]);

            const result = await service.getPreSummaries('consultation-1');

            expect(result).toHaveLength(0);
        });
    });

    describe('getSharedCaseNotes', () => {
        const mockConsultation = {
            id: 'consultation-1',
            tenantId: 'tenant-1',
            patientId: 'patient-1',
            appointmentDate: new Date('2026-02-17'),
        };

        it('should return case notes combining chain + same-day strategies', async () => {
            mockConsultationRepository.findById.mockResolvedValue(mockConsultation);
            const chain = [
                { id: 'parent-id', tenantId: 'tenant-1' },
                { id: 'consultation-1', tenantId: 'tenant-1' },
                { id: 'child-2', tenantId: 'tenant-1' },
            ];
            mockConsultationRepository.findConsultationChain.mockResolvedValue(chain);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                { id: 'parent-id', tenantId: 'tenant-1' },
                { id: 'consultation-1', tenantId: 'tenant-1' },
                { id: 'child-2', tenantId: 'tenant-1' },
                { id: 'unlinked-dept-c', tenantId: 'tenant-1' },
            ]);
            const sharedCaseNotes = [
                createMockContextItemEntity({
                    id: 'case-note-1',
                    consultationId: 'parent-id',
                    type: 'CASE_NOTE' as any,
                }),
                createMockContextItemEntity({
                    id: 'case-note-2',
                    consultationId: 'unlinked-dept-c',
                    type: 'CASE_NOTE' as any,
                }),
            ];
            mockContextItemRepository.findCaseNotesFromChain.mockResolvedValue(sharedCaseNotes);

            const result = await service.getSharedCaseNotes('consultation-1');

            expect(result).toHaveLength(2);
            expect(mockConsultationRepository.findById).toHaveBeenCalledWith('consultation-1');
            expect(mockConsultationRepository.findConsultationChain).toHaveBeenCalledWith('consultation-1');
            expect(mockConsultationRepository.findByPatientAndDate).toHaveBeenCalledWith(
                'tenant-1',
                'patient-1',
                mockConsultation.appointmentDate,
            );
            const passedIds = mockContextItemRepository.findCaseNotesFromChain.mock.calls[0][0] as string[];
            expect(passedIds).toContain('parent-id');
            expect(passedIds).toContain('consultation-1');
            expect(passedIds).toContain('child-2');
            expect(passedIds).toContain('unlinked-dept-c');
            expect(new Set(passedIds).size).toBe(passedIds.length);
        });

        it('should return empty array when consultation not found', async () => {
            mockConsultationRepository.findById.mockResolvedValue(null);

            const result = await service.getSharedCaseNotes('non-existent');

            expect(result).toHaveLength(0);
            expect(mockConsultationRepository.findConsultationChain).not.toHaveBeenCalled();
            expect(mockConsultationRepository.findByPatientAndDate).not.toHaveBeenCalled();
            expect(mockContextItemRepository.findCaseNotesFromChain).not.toHaveBeenCalled();
        });

        it('should return empty array when no case notes in chain or same-day', async () => {
            mockConsultationRepository.findById.mockResolvedValue(mockConsultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([{ id: 'consultation-1', tenantId: 'tenant-1' }]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([{ id: 'consultation-1', tenantId: 'tenant-1' }]);
            mockContextItemRepository.findCaseNotesFromChain.mockResolvedValue([]);

            const result = await service.getSharedCaseNotes('consultation-1');

            expect(result).toHaveLength(0);
        });
    });

    // ============================================
    // PRE_SUMMARY with addContext Tests
    // ============================================

    describe('addContext with PRE_SUMMARY', () => {
        it('should create PRE_SUMMARY context item via addContext', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newPreSummary = createMockContextItemEntity({
                id: 'new-pre-summary-id',
                type: 'PRE_SUMMARY' as any,
                source: 'AI' as any,
                content: 'AI-generated pre-summary of case notes',
                isSummary: true,
                isPreSummary: true,
                isFinalSummary: false,
                isAiGenerated: true,
            });
            mockContextItemRepository.create.mockResolvedValue(newPreSummary);
            const result = await service.addContext('consultation-1', {
                type: 'PRE_SUMMARY' as any,
                source: 'AI' as any,
                content: 'AI-generated pre-summary of case notes',
            });

            expect(result.id).toBe('new-pre-summary-id');
            expect(result.isSummary).toBe(true);
            expect(result.isPreSummary).toBe(true);
            expect(result.isFinalSummary).toBe(false);
            expect(result.isAiGenerated).toBe(true);
        });

        it('should create PRE_SUMMARY with SummaryMeta', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1' });
            const newPreSummary = createMockContextItemEntity({
                id: 'new-pre-summary-id',
                type: 'PRE_SUMMARY' as any,
                source: 'AI' as any,
                content: 'Pre-summary content',
                isSummary: true,
                isPreSummary: true,
            });
            mockContextItemRepository.create.mockResolvedValue(newPreSummary);
            const result = await service.addContext('consultation-1', {
                type: 'PRE_SUMMARY' as any,
                source: 'AI' as any,
                content: 'Pre-summary content',
            });

            expect(result.id).toBe('new-pre-summary-id');
            expect(result.isSummary).toBe(true);
        });
    });

    // ============================================
    // ENH-3: getContextItemsPaginated Tests (TDD)
    // ============================================
    describe('getContextItemsPaginated', () => {
        const createItems = (count: number) =>
            Array.from({ length: count }, (_, i) =>
                createMockContextItemEntity({
                    id: `ctx-${i + 1}`,
                    type: 'TRANSCRIPT' as any,
                    isTranscript: true,
                }),
            );

        it('should return paginated context items with count, page, limit', async () => {
            const items = createItems(10);
            mockContextItemRepository.findByConsultation.mockResolvedValue(items);

            const result = await service.getContextItemsPaginated('consultation-1', {
                page: 1,
                limit: 5,
            });

            expect(result.data).toHaveLength(5);
            expect(result.count).toBe(10);
            expect(result.page).toBe(1);
            expect(result.limit).toBe(5);
        });

        it('should return correct slice for page 2', async () => {
            const items = createItems(10);
            mockContextItemRepository.findByConsultation.mockResolvedValue(items);

            const result = await service.getContextItemsPaginated('consultation-1', {
                page: 2,
                limit: 3,
            });

            expect(result.data).toHaveLength(3);
            expect(result.count).toBe(10);
            expect(result.page).toBe(2);
            // Items should be ctx-4, ctx-5, ctx-6 (skip=3, take=3)
            expect(result.data[0].id).toBe('ctx-4');
            expect(result.data[2].id).toBe('ctx-6');
        });

        it('should return partial page when at end of data', async () => {
            const items = createItems(7);
            mockContextItemRepository.findByConsultation.mockResolvedValue(items);

            const result = await service.getContextItemsPaginated('consultation-1', {
                page: 2,
                limit: 5,
            });

            expect(result.data).toHaveLength(2); // items 6-7
            expect(result.count).toBe(7);
        });

        it('should return empty data when page is beyond range', async () => {
            const items = createItems(5);
            mockContextItemRepository.findByConsultation.mockResolvedValue(items);

            const result = await service.getContextItemsPaginated('consultation-1', {
                page: 10,
                limit: 5,
            });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(5);
        });

        it('should default to page=1 and limit=50 when filters omitted', async () => {
            const items = createItems(3);
            mockContextItemRepository.findByConsultation.mockResolvedValue(items);

            const result = await service.getContextItemsPaginated('consultation-1');

            expect(result.page).toBe(1);
            expect(result.limit).toBe(50);
            expect(result.data).toHaveLength(3);
            expect(result.count).toBe(3);
        });

        it('should default to page=1 and limit=50 when filters has no page/limit', async () => {
            const items = createItems(3);
            mockContextItemRepository.findByConsultation.mockResolvedValue(items);

            const result = await service.getContextItemsPaginated('consultation-1', {
                type: 'TRANSCRIPT',
            });

            expect(result.page).toBe(1);
            expect(result.limit).toBe(50);
        });

        it('should pass type and source filters to repository', async () => {
            mockContextItemRepository.findByConsultation.mockResolvedValue([]);

            await service.getContextItemsPaginated('consultation-1', {
                type: 'TRANSCRIPT',
                source: 'ai',
                page: 1,
                limit: 10,
            });

            expect(mockContextItemRepository.findByConsultation).toHaveBeenCalledWith(
                'consultation-1',
                expect.objectContaining({ type: 'TRANSCRIPT', source: 'ai' }),
            );
        });

        it('should handle zero items', async () => {
            mockContextItemRepository.findByConsultation.mockResolvedValue([]);

            const result = await service.getContextItemsPaginated('consultation-1', {
                page: 1,
                limit: 20,
            });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
            expect(result.page).toBe(1);
            expect(result.limit).toBe(20);
        });

        it('should broadcast SysEvent with pagination metadata', async () => {
            mockContextItemRepository.findByConsultation.mockResolvedValue(createItems(15));

            await service.getContextItemsPaginated('consultation-1', {
                page: 2,
                limit: 5,
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    data: expect.objectContaining({
                        consultationId: 'consultation-1',
                        page: 2,
                        limit: 5,
                        count: 15,
                    }),
                }),
            );
        });
    });

    // ============================================
    // getAggregateNamedEntities Tests (ENH-1)
    // ============================================

    describe('getAggregateNamedEntities', () => {
        const mockConsultationA = {
            id: 'consultation-a',
            tenantId: 'tenant-1',
            patientId: 'patient-1',
            appointmentDate: new Date('2026-02-17'),
            doctorId: 'doctor-a-id',
            departmentId: 'dept-gen',
            Doctor: {
                username: 'dr.smith',
                UserProfile: { firstName: 'John', lastName: 'Smith' },
            },
            Department: { name: 'General Medicine' },
        };

        const mockConsultationB = {
            id: 'consultation-b',
            tenantId: 'tenant-1',
            patientId: 'patient-1',
            appointmentDate: new Date('2026-02-17'),
            doctorId: 'doctor-b-id',
            departmentId: 'dept-hema',
            Doctor: {
                username: 'dr.brown',
                UserProfile: { firstName: 'Bob', lastName: 'Brown' },
            },
            Department: { name: 'Hematology' },
        };

        const setupChainResolution = () => {
            mockConsultationRepository.findById.mockResolvedValue(mockConsultationA);
            // TASK-306 P2.5 — chain/sameDay rows MUST carry `tenantId` so
            // the new in-tenant filter in `resolveLinkedConsultationIds`
            // accepts them. Pre-fix mocks omitted the field; today's
            // service code filters such rows out.
            mockConsultationRepository.findConsultationChain.mockResolvedValue([
                { id: 'consultation-a', tenantId: 'tenant-1' },
            ]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                { id: 'consultation-a', tenantId: 'tenant-1' },
                { id: 'consultation-b', tenantId: 'tenant-1' },
            ]);
        };

        it('should return empty response when consultation not found', async () => {
            mockConsultationRepository.findById.mockResolvedValue(null);

            const result = await service.getAggregateNamedEntities('non-existent', 'chain');

            expect(result.consultationId).toBe('non-existent');
            expect(result.scope).toBe('chain');
            expect(result.entities).toEqual({});
            expect(result.totalCount).toBe(0);
            expect(result.countByClass).toEqual({});
            expect(result.sources).toEqual([]);
        });

        it('should aggregate entities from chain + same-day consultations', async () => {
            setupChainResolution();
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA)
                .mockResolvedValueOnce(mockConsultationB);

            // Consultation A has a summary with NER
            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
                isSummary: true,
            });
            mockContextItemRepository.findSummaries
                .mockResolvedValueOnce([summaryA])
                .mockResolvedValueOnce([]);
            mockContextItemRepository.findTranscripts
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            // Consultation B has a transcript with NER
            const transcriptB = createMockContextItemEntity({
                id: 'transcript-b',
                consultationId: 'consultation-b',
                type: 'TRANSCRIPT',
                isTranscript: true,
            });
            mockContextItemRepository.findSummaries
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);
            // Re-setup for B since first call was for A
            mockContextItemRepository.findSummaries.mockReset();
            mockContextItemRepository.findTranscripts.mockReset();
            mockContextItemRepository.findSummaries
                .mockResolvedValueOnce([summaryA])  // consultation-a
                .mockResolvedValueOnce([]);         // consultation-b
            mockContextItemRepository.findTranscripts
                .mockResolvedValueOnce([])          // consultation-a
                .mockResolvedValueOnce([transcriptB]); // consultation-b

            const aspirinEntity = createMockNamedEntityEntity({
                id: 'ne-1',
                text: 'Aspirin',
                className: 'MEDICATION',
                confidence: 0.95,
                contextItemId: 'summary-a',
            });
            const headacheEntity = createMockNamedEntityEntity({
                id: 'ne-2',
                text: 'Headache',
                className: 'CONDITION',
                confidence: 0.88,
                contextItemId: 'summary-a',
            });
            const metforminEntity = createMockNamedEntityEntity({
                id: 'ne-3',
                text: 'Metformin',
                className: 'MEDICATION',
                confidence: 0.92,
                contextItemId: 'transcript-b',
            });

            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([aspirinEntity, headacheEntity])  // summary-a
                .mockResolvedValueOnce([metforminEntity]);               // transcript-b

            const result = await service.getAggregateNamedEntities('consultation-a', 'chain');

            expect(result.consultationId).toBe('consultation-a');
            expect(result.scope).toBe('chain');
            expect(result.totalCount).toBe(3);
            expect(result.countByClass).toEqual({
                MEDICATION: 2,
                CONDITION: 1,
            });
            expect(result.entities.MEDICATION).toHaveLength(2);
            expect(result.entities.CONDITION).toHaveLength(1);
            expect(result.entities.MEDICATION.map(e => e.text)).toContain('Aspirin');
            expect(result.entities.MEDICATION.map(e => e.text)).toContain('Metformin');
        });

        it('should scope to single consultation when scope=single', async () => {
            // For single scope, no chain resolution needed
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            const aspirinEntity = createMockNamedEntityEntity({
                id: 'ne-1',
                text: 'Aspirin',
                className: 'MEDICATION',
            });
            mockNamedEntityRepository.findByContextItem.mockResolvedValueOnce([aspirinEntity]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            expect(result.scope).toBe('single');
            expect(result.totalCount).toBe(1);
            expect(result.entities.MEDICATION).toHaveLength(1);
            // Chain resolution should NOT be called for single scope
            expect(mockConsultationRepository.findConsultationChain).not.toHaveBeenCalled();
            expect(mockConsultationRepository.findByPatientAndDate).not.toHaveBeenCalled();
        });

        it('should deduplicate entities by (text, sourceConsultationId) within same class', async () => {
            setupChainResolution();
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA)
                .mockResolvedValueOnce(mockConsultationB);

            // Consultation A has two context items with the same entity text
            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            const transcriptA = createMockContextItemEntity({
                id: 'transcript-a',
                consultationId: 'consultation-a',
                type: 'TRANSCRIPT',
            });
            mockContextItemRepository.findSummaries
                .mockResolvedValueOnce([summaryA])  // consultation-a
                .mockResolvedValueOnce([]);         // consultation-b
            mockContextItemRepository.findTranscripts
                .mockResolvedValueOnce([transcriptA])  // consultation-a
                .mockResolvedValueOnce([]);            // consultation-b

            const aspirinFromSummary = createMockNamedEntityEntity({
                id: 'ne-1',
                text: 'Aspirin',
                className: 'MEDICATION',
            });
            const aspirinFromTranscript = createMockNamedEntityEntity({
                id: 'ne-2',
                text: 'Aspirin',
                className: 'MEDICATION',
            });
            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([aspirinFromSummary])     // summary-a
                .mockResolvedValueOnce([aspirinFromTranscript])  // transcript-a
                .mockResolvedValueOnce([]);                      // no entities from consultation-b

            const result = await service.getAggregateNamedEntities('consultation-a', 'chain');

            // Should deduplicate: Aspirin from consultation-a appears only once
            expect(result.entities.MEDICATION).toHaveLength(1);
            expect(result.totalCount).toBe(1);
        });

        it('should allow same text from different consultations', async () => {
            setupChainResolution();
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA)
                .mockResolvedValueOnce(mockConsultationB);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            const summaryB = createMockContextItemEntity({
                id: 'summary-b',
                consultationId: 'consultation-b',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries
                .mockResolvedValueOnce([summaryA])  // consultation-a
                .mockResolvedValueOnce([summaryB]); // consultation-b
            mockContextItemRepository.findTranscripts
                .mockResolvedValueOnce([])  // consultation-a
                .mockResolvedValueOnce([]); // consultation-b

            // Both consultations mention Aspirin — should NOT be deduplicated
            // because they come from different sourceConsultationIds
            const aspirinA = createMockNamedEntityEntity({
                id: 'ne-1',
                text: 'Aspirin',
                className: 'MEDICATION',
            });
            const aspirinB = createMockNamedEntityEntity({
                id: 'ne-2',
                text: 'Aspirin',
                className: 'MEDICATION',
            });
            // Reset to clear any lingering state, then set up sequentially
            mockNamedEntityRepository.findByContextItem.mockReset();
            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([aspirinA])  // summary-a (consultation-a)
                .mockResolvedValueOnce([aspirinB]); // summary-b (consultation-b)

            const result = await service.getAggregateNamedEntities('consultation-a', 'chain');

            // Aspirin from consultation-a and consultation-b are different sources
            expect(result.entities.MEDICATION).toHaveLength(2);
            expect(result.totalCount).toBe(2);
        });

        it('should return empty entities when no NER data exists', async () => {
            setupChainResolution();
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA)
                .mockResolvedValueOnce(mockConsultationB);

            // Both consultations have summaries but no NER entities
            mockContextItemRepository.findSummaries
                .mockResolvedValueOnce([createMockContextItemEntity({ id: 'summary-a' })])
                .mockResolvedValueOnce([createMockContextItemEntity({ id: 'summary-b' })]);
            mockContextItemRepository.findTranscripts
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);
            // Reset and set persistent empty return for all findByContextItem calls
            mockNamedEntityRepository.findByContextItem.mockReset();
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'chain');

            expect(result.entities).toEqual({});
            expect(result.totalCount).toBe(0);
            expect(result.countByClass).toEqual({});
            expect(result.sources).toEqual([]);
        });

        it('should populate source metadata with department and doctor', async () => {
            setupChainResolution();
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA)
                .mockResolvedValueOnce(mockConsultationB);

            // Only consultation A has entities
            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries
                .mockResolvedValueOnce([summaryA])
                .mockResolvedValueOnce([]);
            mockContextItemRepository.findTranscripts
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            const entity = createMockNamedEntityEntity({
                id: 'ne-1',
                text: 'Aspirin',
                className: 'MEDICATION',
            });
            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([entity]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'chain');

            // Sources should only contain consultations that contributed entities
            expect(result.sources).toHaveLength(1);
            expect(result.sources[0]).toEqual({
                consultationId: 'consultation-a',
                department: 'General Medicine',
                departmentId: 'dept-gen',
                doctor: 'John Smith',
                doctorId: 'doctor-a-id',
            });
        });

        it('should include sourceContextItemId and sourceContextType in entity items', async () => {
            setupChainResolution();
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA)
                .mockResolvedValueOnce(mockConsultationB);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries
                .mockResolvedValueOnce([summaryA])
                .mockResolvedValueOnce([]);
            mockContextItemRepository.findTranscripts
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            const entity = createMockNamedEntityEntity({
                id: 'ne-1',
                text: 'Aspirin',
                className: 'MEDICATION',
                aiModelId: 'ner-model-1',
            });
            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([entity]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'chain');

            const med = result.entities.MEDICATION[0];
            expect(med.id).toBe('ne-1');
            expect(med.sourceContextItemId).toBe('summary-a');
            expect(med.sourceContextType).toBe('RAW_SUMMARY');
            expect(med.aiModelId).toBe('ner-model-1');
            expect(med.isHighConfidence).toBe(true);
            expect(med.displayText).toBeDefined();
            expect(med.createdAt).toBeDefined();
        });

        it('should mark low-confidence entities correctly', async () => {
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            const lowConfEntity = createMockNamedEntityEntity({
                id: 'ne-low',
                text: 'Possible condition',
                className: 'CONDITION',
                confidence: 0.35,
                isHighConfidence: false,
            });
            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([lowConfEntity]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            const condition = result.entities.CONDITION[0];
            expect(condition.confidence).toBe(0.35);
            expect(condition.isHighConfidence).toBe(false);
        });

        it('should broadcast SysEvent with aggregation metadata', async () => {
            setupChainResolution();
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA)
                .mockResolvedValueOnce(mockConsultationB);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries
                .mockResolvedValueOnce([summaryA])
                .mockResolvedValueOnce([]);
            mockContextItemRepository.findTranscripts
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([
                    createMockNamedEntityEntity({ id: 'ne-1', text: 'Aspirin', className: 'MEDICATION' }),
                    createMockNamedEntityEntity({ id: 'ne-2', text: 'Headache', className: 'CONDITION' }),
                ]);

            await service.getAggregateNamedEntities('consultation-a', 'chain');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    data: expect.objectContaining({
                        consultationId: 'consultation-a',
                        scope: 'chain',
                        totalCount: 2,
                        sourceConsultationCount: 1,
                        classCount: 2,
                    }),
                }),
            );
        });

        it('should handle realistic multi-department NER aggregation', async () => {
            setupChainResolution();
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA)
                .mockResolvedValueOnce(mockConsultationB);

            // Doctor A has a summary, Doctor B has a transcript
            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            const transcriptB = createMockContextItemEntity({
                id: 'transcript-b',
                consultationId: 'consultation-b',
                type: 'TRANSCRIPT',
            });
            mockContextItemRepository.findSummaries
                .mockResolvedValueOnce([summaryA])     // consultation-a
                .mockResolvedValueOnce([]);            // consultation-b
            mockContextItemRepository.findTranscripts
                .mockResolvedValueOnce([])             // consultation-a
                .mockResolvedValueOnce([transcriptB]); // consultation-b

            // Doctor A's summary NER: medications + conditions
            const aEntities = [
                createMockNamedEntityEntity({ id: 'ne-1', text: 'Aspirin 75mg', className: 'MEDICATION', confidence: 0.95 }),
                createMockNamedEntityEntity({ id: 'ne-2', text: 'Hypertension', className: 'CONDITION', confidence: 0.92 }),
                createMockNamedEntityEntity({ id: 'ne-3', text: 'Type 2 Diabetes', className: 'CONDITION', confidence: 0.91 }),
            ];
            // Doctor B's transcript NER: medications + procedures
            const bEntities = [
                createMockNamedEntityEntity({ id: 'ne-4', text: 'Metformin 500mg', className: 'MEDICATION', confidence: 0.93 }),
                createMockNamedEntityEntity({ id: 'ne-5', text: 'CBC', className: 'PROCEDURE', confidence: 0.97 }),
                createMockNamedEntityEntity({ id: 'ne-6', text: 'Blood glucose test', className: 'PROCEDURE', confidence: 0.89 }),
            ];
            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce(aEntities)
                .mockResolvedValueOnce(bEntities);

            const result = await service.getAggregateNamedEntities('consultation-a', 'chain');

            // Verify aggregation structure
            expect(result.totalCount).toBe(6);
            expect(result.countByClass).toEqual({
                MEDICATION: 2,
                CONDITION: 2,
                PROCEDURE: 2,
            });
            expect(result.entities.MEDICATION.map(e => e.text)).toEqual(
                expect.arrayContaining(['Aspirin 75mg', 'Metformin 500mg']),
            );
            expect(result.entities.CONDITION.map(e => e.text)).toEqual(
                expect.arrayContaining(['Hypertension', 'Type 2 Diabetes']),
            );
            expect(result.entities.PROCEDURE.map(e => e.text)).toEqual(
                expect.arrayContaining(['CBC', 'Blood glucose test']),
            );

            // Verify sources (both consultations contributed entities)
            expect(result.sources).toHaveLength(2);
            expect(result.sources.map(s => s.department)).toEqual(
                expect.arrayContaining(['General Medicine', 'Hematology']),
            );
            expect(result.sources.map(s => s.doctor)).toEqual(
                expect.arrayContaining(['John Smith', 'Bob Brown']),
            );
        });

        it('should fall back to username when doctor has no UserProfile', async () => {
            const consultationNoProfile = {
                ...mockConsultationA,
                Doctor: { username: 'dr.smith' },
            };
            mockConsultationRepository.findById.mockResolvedValue(consultationNoProfile);
            mockConsultationRepository.findWithRelations.mockResolvedValueOnce(consultationNoProfile);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([createMockNamedEntityEntity()]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            expect(result.sources[0].doctor).toBe('dr.smith');
        });

        // ============================================
        // Edge Case Tests (TDD verification)
        // ============================================

        it('should map entity with null className to UNKNOWN', async () => {
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            const entityWithNullClass = createMockNamedEntityEntity({
                id: 'ne-null-class',
                text: 'Something',
                className: null as any,
            });
            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([entityWithNullClass]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            expect(result.entities['UNKNOWN']).toBeDefined();
            expect(result.entities['UNKNOWN']).toHaveLength(1);
            expect(result.entities['UNKNOWN'][0].text).toBe('Something');
            expect(result.countByClass['UNKNOWN']).toBe(1);
        });

        it('should map entity with null text to empty string', async () => {
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            const entityWithNullText = createMockNamedEntityEntity({
                id: 'ne-null-text',
                text: null as any,
                className: 'MEDICATION',
            });
            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([entityWithNullText]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            expect(result.entities.MEDICATION[0].text).toBe('');
        });

        it('should set isHighConfidence to false when confidence is null', async () => {
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            const entityNullConf = createMockNamedEntityEntity({
                id: 'ne-null-conf',
                text: 'Aspirin',
                className: 'MEDICATION',
                confidence: null,
            });
            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([entityNullConf]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            expect(result.entities.MEDICATION[0].confidence).toBeUndefined();
            expect(result.entities.MEDICATION[0].isHighConfidence).toBe(false);
        });

        it('should set isHighConfidence to true when confidence is exactly 0.8 (boundary)', async () => {
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            const entityBoundary = createMockNamedEntityEntity({
                id: 'ne-boundary',
                text: 'Aspirin',
                className: 'MEDICATION',
                confidence: 0.8,
            });
            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([entityBoundary]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            expect(result.entities.MEDICATION[0].isHighConfidence).toBe(true);
        });

        it('should set isHighConfidence to false when confidence is 0.79 (below boundary)', async () => {
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            const entityBelow = createMockNamedEntityEntity({
                id: 'ne-below',
                text: 'Aspirin',
                className: 'MEDICATION',
                confidence: 0.79,
            });
            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([entityBelow]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            expect(result.entities.MEDICATION[0].isHighConfidence).toBe(false);
        });

        it('should handle consultation with no Doctor relation in sources', async () => {
            const consultationNoDoctor = {
                id: 'consultation-a',
                tenantId: 'tenant-1',
                patientId: 'patient-1',
                appointmentDate: new Date('2026-02-17'),
                doctorId: 'doctor-a-id',
                departmentId: 'dept-gen',
                Doctor: null,
                Department: { name: 'General Medicine' },
            };
            mockConsultationRepository.findById.mockResolvedValue(consultationNoDoctor);
            mockConsultationRepository.findWithRelations.mockResolvedValueOnce(consultationNoDoctor);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([createMockNamedEntityEntity()]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            expect(result.sources[0].doctor).toBeUndefined();
            expect(result.sources[0].department).toBe('General Medicine');
        });

        it('should handle consultation with no Department relation in sources', async () => {
            const consultationNoDept = {
                id: 'consultation-a',
                tenantId: 'tenant-1',
                patientId: 'patient-1',
                appointmentDate: new Date('2026-02-17'),
                doctorId: 'doctor-a-id',
                departmentId: 'dept-gen',
                Doctor: {
                    username: 'dr.smith',
                    UserProfile: { firstName: 'John', lastName: 'Smith' },
                },
                Department: null,
            };
            mockConsultationRepository.findById.mockResolvedValue(consultationNoDept);
            mockConsultationRepository.findWithRelations.mockResolvedValueOnce(consultationNoDept);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([createMockNamedEntityEntity()]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            expect(result.sources[0].department).toBeUndefined();
            expect(result.sources[0].doctor).toBe('John Smith');
        });

        it('should format doctor name with only firstName (no lastName)', async () => {
            const consultationFirstOnly = {
                ...mockConsultationA,
                Doctor: {
                    username: 'dr.smith',
                    UserProfile: { firstName: 'John', lastName: null },
                },
            };
            mockConsultationRepository.findById.mockResolvedValue(consultationFirstOnly);
            mockConsultationRepository.findWithRelations.mockResolvedValueOnce(consultationFirstOnly);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([createMockNamedEntityEntity()]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            expect(result.sources[0].doctor).toBe('John');
        });

        it('should format doctor name with only lastName (no firstName)', async () => {
            const consultationLastOnly = {
                ...mockConsultationA,
                Doctor: {
                    username: 'dr.smith',
                    UserProfile: { firstName: null, lastName: 'Smith' },
                },
            };
            mockConsultationRepository.findById.mockResolvedValue(consultationLastOnly);
            mockConsultationRepository.findWithRelations.mockResolvedValueOnce(consultationLastOnly);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([createMockNamedEntityEntity()]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            expect(result.sources[0].doctor).toBe('Smith');
        });

        it('should skip consultations where findWithRelations returns null', async () => {
            setupChainResolution();
            // consultation-a resolves, consultation-b returns null from findWithRelations
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA)
                .mockResolvedValueOnce(null);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            // consultation-a has a summary, consultation-b still iterated for entities
            mockContextItemRepository.findSummaries
                .mockResolvedValueOnce([summaryA])
                .mockResolvedValueOnce([]);
            mockContextItemRepository.findTranscripts
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([createMockNamedEntityEntity({ id: 'ne-1' })]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'chain');

            // Source metadata for consultation-a should be populated
            expect(result.sources).toHaveLength(1);
            expect(result.sources[0].consultationId).toBe('consultation-a');
            expect(result.sources[0].department).toBe('General Medicine');
        });

        it('should handle consultation with no summaries and no transcripts', async () => {
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA);

            // No summaries, no transcripts
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            expect(result.entities).toEqual({});
            expect(result.totalCount).toBe(0);
            expect(result.sources).toEqual([]);
            // findByContextItem should never be called since there are no context items
            expect(mockNamedEntityRepository.findByContextItem).not.toHaveBeenCalled();
        });

        it('should use displayText fallback to text when displayText is null', async () => {
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            const entityNoDisplay = {
                ...createMockNamedEntityEntity({
                    id: 'ne-no-display',
                    text: 'Aspirin',
                    className: 'MEDICATION',
                }),
                displayText: null,
            };
            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([entityNoDisplay]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            // Should fall back to text when displayText is null
            expect(result.entities.MEDICATION[0].displayText).toBe('Aspirin');
        });

        it('should ensure totalCount equals sum of all entity array lengths', async () => {
            setupChainResolution();
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA)
                .mockResolvedValueOnce(mockConsultationB);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            const transcriptB = createMockContextItemEntity({
                id: 'transcript-b',
                consultationId: 'consultation-b',
                type: 'TRANSCRIPT',
            });
            mockContextItemRepository.findSummaries
                .mockResolvedValueOnce([summaryA])
                .mockResolvedValueOnce([]);
            mockContextItemRepository.findTranscripts
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([transcriptB]);

            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([
                    createMockNamedEntityEntity({ id: 'ne-1', text: 'Aspirin', className: 'MEDICATION' }),
                    createMockNamedEntityEntity({ id: 'ne-2', text: 'Headache', className: 'CONDITION' }),
                    createMockNamedEntityEntity({ id: 'ne-3', text: 'Migraine', className: 'CONDITION' }),
                ])
                .mockResolvedValueOnce([
                    createMockNamedEntityEntity({ id: 'ne-4', text: 'CBC', className: 'PROCEDURE' }),
                ]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'chain');

            // Verify totalCount is the sum of all entity arrays
            const sumFromEntities = Object.values(result.entities)
                .reduce((sum, arr) => sum + arr.length, 0);
            expect(result.totalCount).toBe(sumFromEntities);
            expect(result.totalCount).toBe(4);

            // Verify countByClass matches entity array lengths
            for (const [className, items] of Object.entries(result.entities)) {
                expect(result.countByClass[className]).toBe(items.length);
            }
        });

        it('should preserve createdAt as ISO-8601 string', async () => {
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(mockConsultationA);

            const summaryA = createMockContextItemEntity({
                id: 'summary-a',
                consultationId: 'consultation-a',
                type: 'RAW_SUMMARY',
            });
            mockContextItemRepository.findSummaries.mockResolvedValueOnce([summaryA]);
            mockContextItemRepository.findTranscripts.mockResolvedValueOnce([]);

            const specificDate = new Date('2026-02-17T14:30:00.000Z');
            const entity = createMockNamedEntityEntity({
                id: 'ne-date',
                text: 'Aspirin',
                className: 'MEDICATION',
                createdAt: specificDate,
            });
            mockNamedEntityRepository.findByContextItem
                .mockResolvedValueOnce([entity]);

            const result = await service.getAggregateNamedEntities('consultation-a', 'single');

            expect(result.entities.MEDICATION[0].createdAt).toBe('2026-02-17T14:30:00.000Z');
        });
    });

    // ============================================================
    // TASK-305 D.3 — Cross-aggregate tenant isolation for ContextService
    //
    // The ContextItem aggregate owns three cross-aggregate references the
    // multi-tenancy audit (C-3) flagged as leak vectors:
    //   - consultationId            (parent Consultation, on every create)
    //   - contextItemId             (parent ContextItem, on update / NER add)
    //   - caseNoteIds / preSummaryIds /
    //     previousSummaryIds        (ContextItem chains stored on SummaryMeta)
    //
    // Each must be asserted in the caller's tenant before any factory or
    // repository call runs. Failures route through `assertParentInScope`,
    // which throws `NotFoundException` (no existence leak).
    // ============================================================
    describe('TASK-305 D.3 — cross-aggregate tenant checks', () => {
        describe('addContext', () => {
            it('throws NotFoundException when parent consultation belongs to another tenant', async () => {
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-other',
                    tenantId: 'tenant-OTHER',
                });

                await expect(
                    service.addContext('consultation-other', {
                        type: ContextItemType.TRANSCRIPT,
                        content: 'cross-tenant attempt',
                    }),
                ).rejects.toThrow(NotFoundException);
                await expect(
                    service.addContext('consultation-other', {
                        type: ContextItemType.TRANSCRIPT,
                        content: 'cross-tenant attempt',
                    }),
                ).rejects.toThrow('Resource not found');

                expect(mockContextItemRepository.create).not.toHaveBeenCalled();
            });

            it('throws NotFoundException when parent consultation does not exist (no existence leak)', async () => {
                mockConsultationRepository.findById.mockResolvedValue(null);

                await expect(
                    service.addContext('no-such-consultation', {
                        type: ContextItemType.TRANSCRIPT,
                        content: 'x',
                    }),
                ).rejects.toThrow(NotFoundException);
                expect(mockContextItemRepository.create).not.toHaveBeenCalled();
            });
        });

        describe('updateContext', () => {
            it('throws NotFoundException when context item belongs to another tenant', async () => {
                mockContextItemRepository.findById.mockResolvedValue(
                    createMockContextItemEntity({
                        id: 'ctx-other',
                        tenantId: 'tenant-OTHER',
                    }),
                );

                await expect(
                    service.updateContext('ctx-other', { content: 'tampered' }),
                ).rejects.toThrow(NotFoundException);
                await expect(
                    service.updateContext('ctx-other', { content: 'tampered' }),
                ).rejects.toThrow('Resource not found');

                expect(mockContextItemRepository.update).not.toHaveBeenCalled();
            });
        });

        describe('addAudioRecording', () => {
            it('throws NotFoundException when parent consultation belongs to another tenant', async () => {
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-other',
                    tenantId: 'tenant-OTHER',
                });

                await expect(
                    service.addAudioRecording('consultation-other', {
                        mediaId: 'm-1',
                    }),
                ).rejects.toThrow(NotFoundException);
                expect(mockAudioRecordingRepository.create).not.toHaveBeenCalled();
            });
        });

        describe('addRawSummary', () => {
            it('throws NotFoundException when parent consultation belongs to another tenant', async () => {
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-other',
                    tenantId: 'tenant-OTHER',
                });

                await expect(
                    service.addRawSummary('consultation-other', {
                        content: 'cross-tenant summary',
                    }),
                ).rejects.toThrow(NotFoundException);
                expect(mockContextItemRepository.create).not.toHaveBeenCalled();
                expect(mockSummaryMetaRepository.create).not.toHaveBeenCalled();
            });

            it('throws NotFoundException when any caseNoteIds entry lives in another tenant', async () => {
                // Parent consultation passes the in-tenant check.
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-1',
                    tenantId: 'tenant-1',
                });
                // First case note in-tenant; second cross-tenant → reject.
                mockContextItemRepository.findById
                    .mockResolvedValueOnce(createMockContextItemEntity({ id: 'note-good', tenantId: 'tenant-1' }))
                    .mockResolvedValueOnce(createMockContextItemEntity({ id: 'note-bad', tenantId: 'tenant-OTHER' }));

                await expect(
                    service.addRawSummary('consultation-1', {
                        content: 'summary',
                        caseNoteIds: ['note-good', 'note-bad'],
                    }),
                ).rejects.toThrow(NotFoundException);
                expect(mockSummaryMetaRepository.create).not.toHaveBeenCalled();
            });

            it('throws NotFoundException when any previousSummaryIds entry lives in another tenant', async () => {
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-1',
                    tenantId: 'tenant-1',
                });
                mockContextItemRepository.findById.mockResolvedValueOnce(
                    createMockContextItemEntity({ id: 'prev-bad', tenantId: 'tenant-OTHER' }),
                );

                await expect(
                    service.addRawSummary('consultation-1', {
                        content: 'summary',
                        previousSummaryIds: ['prev-bad'],
                    }),
                ).rejects.toThrow(NotFoundException);
                expect(mockSummaryMetaRepository.create).not.toHaveBeenCalled();
            });
        });

        describe('addNamedEntities', () => {
            it('throws NotFoundException when parent context item belongs to another tenant', async () => {
                mockContextItemRepository.findById.mockResolvedValue(
                    createMockContextItemEntity({
                        id: 'ctx-other',
                        tenantId: 'tenant-OTHER',
                    }),
                );

                await expect(
                    service.addNamedEntities('ctx-other', {
                        entities: [{ text: 'Aspirin', className: 'MEDICATION' }],
                    }),
                ).rejects.toThrow(NotFoundException);
                expect(mockNamedEntityRepository.create).not.toHaveBeenCalled();
            });
        });
    });

    // ============================================================
    // TASK-306 P2.5 / AC-9 — ContextItem array-input defense-in-depth.
    //
    // The three public read paths that consume the consultation-ID
    // array resolved by `resolveLinkedConsultationIds` and pass it to
    // an `ids: string[]` repository method:
    //   - `getSharedContext`        → findSharedContext(allIds)
    //   - `getSharedCaseNotes`      → findCaseNotesFromChain(allIds)
    //   - `getAggregateNamedEntities('chain')` via the same helper
    //
    // These tests simulate the defense-in-depth scenarios called out
    // in the W5.4.1 audit comment:
    //   - root returned cross-tenant (extension defeated upstream)
    //   - chain straddles tenants (parentConsultationId poisoning)
    //   - missing CLS tenant (background-worker context, must
    //     fail closed to [] without an exception on this hot read path)
    //
    // For each test, mocks return cross-tenant rows directly to drive
    // the negative path; the post-fix expectation is that the
    // downstream repo call either is skipped entirely or receives the
    // filtered (own-tenant only) id array.
    // ============================================================
    describe('TASK-306 P2.5 — ContextItem array-input defense-in-depth', () => {
        const inTenantRoot = {
            id: 'consultation-1',
            tenantId: 'tenant-1',
            patientId: 'patient-1',
            appointmentDate: new Date('2026-02-17'),
        };

        describe('getSharedContext', () => {
            it('returns items when the entire chain belongs to caller tenant (sanity)', async () => {
                mockConsultationRepository.findById.mockResolvedValue(inTenantRoot);
                mockConsultationRepository.findConsultationChain.mockResolvedValue([
                    { id: 'consultation-1', tenantId: 'tenant-1' },
                    { id: 'parent-id', tenantId: 'tenant-1' },
                ]);
                mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                    { id: 'consultation-1', tenantId: 'tenant-1' },
                ]);
                const sharedItems = [createMockContextItemEntity({ consultationId: 'consultation-1' })];
                mockContextItemRepository.findSharedContext.mockResolvedValue(sharedItems);

                const result = await service.getSharedContext('consultation-1');

                expect(result).toHaveLength(1);
                const passedIds = mockContextItemRepository.findSharedContext.mock.calls[0][0] as string[];
                expect(passedIds).toContain('consultation-1');
                expect(passedIds).toContain('parent-id');
                expect(mockConsultationRepository.findByPatientAndDate).toHaveBeenCalledWith(
                    'tenant-1',
                    'patient-1',
                    inTenantRoot.appointmentDate,
                );
            });

            it('returns [] when findById returns a foreign-tenant root (simulated defeated extension)', async () => {
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-foreign',
                    tenantId: 'tenant-OTHER',
                    patientId: 'patient-1',
                    appointmentDate: new Date('2026-02-17'),
                });
                mockConsultationRepository.findConsultationChain.mockResolvedValue([
                    { id: 'consultation-foreign', tenantId: 'tenant-OTHER' },
                ]);
                mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                    { id: 'consultation-foreign', tenantId: 'tenant-OTHER' },
                ]);
                mockContextItemRepository.findSharedContext.mockResolvedValue([
                    createMockContextItemEntity({
                        consultationId: 'consultation-foreign',
                        tenantId: 'tenant-OTHER',
                    }),
                ]);

                const result = await service.getSharedContext('consultation-foreign');

                expect(result).toEqual([]);
                expect(mockContextItemRepository.findSharedContext).not.toHaveBeenCalled();
                expect(mockEventEmitter.emit).not.toHaveBeenCalled();
            });

            it('filters poisoned chain rows to caller tenant before passing ids downstream', async () => {
                mockConsultationRepository.findById.mockResolvedValue(inTenantRoot);
                mockConsultationRepository.findConsultationChain.mockResolvedValue([
                    { id: 'consultation-1', tenantId: 'tenant-1' },
                    { id: 'child-foreign', tenantId: 'tenant-OTHER' },
                ]);
                mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                    { id: 'consultation-1', tenantId: 'tenant-1' },
                ]);
                const sharedItems = [createMockContextItemEntity({ consultationId: 'consultation-1' })];
                mockContextItemRepository.findSharedContext.mockResolvedValue(sharedItems);

                const result = await service.getSharedContext('consultation-1');

                expect(result).toHaveLength(1);
                const passedIds = mockContextItemRepository.findSharedContext.mock.calls[0][0] as string[];
                expect(passedIds).toContain('consultation-1');
                expect(passedIds).not.toContain('child-foreign');
            });

            it('keeps only own-tenant ids when chain is entirely foreign except for the same-day root', async () => {
                mockConsultationRepository.findById.mockResolvedValue(inTenantRoot);
                mockConsultationRepository.findConsultationChain.mockResolvedValue([
                    { id: 'child-foreign', tenantId: 'tenant-OTHER' },
                ]);
                mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                    { id: 'consultation-1', tenantId: 'tenant-1' },
                ]);
                const sharedItems = [createMockContextItemEntity({ consultationId: 'consultation-1' })];
                mockContextItemRepository.findSharedContext.mockResolvedValue(sharedItems);

                const result = await service.getSharedContext('consultation-1');

                expect(result).toHaveLength(1);
                const passedIds = mockContextItemRepository.findSharedContext.mock.calls[0][0] as string[];
                expect(passedIds).toEqual(['consultation-1']);
                expect(passedIds).not.toContain('child-foreign');
            });

            it('returns [] when CLS tenantId is missing (hot read path: leak-by-absence is acceptable)', async () => {
                mockClsService.get.mockImplementation((key: string) => {
                    if (key === 'tenantId') return null;
                    if (key === 'user') return { id: 'user-id-1' };
                    return null;
                });
                mockConsultationRepository.findById.mockResolvedValue(inTenantRoot);
                mockConsultationRepository.findConsultationChain.mockResolvedValue([
                    { id: 'consultation-1', tenantId: 'tenant-1' },
                ]);
                mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                    { id: 'consultation-1', tenantId: 'tenant-1' },
                ]);

                const result = await service.getSharedContext('consultation-1');

                expect(result).toEqual([]);
                expect(mockContextItemRepository.findSharedContext).not.toHaveBeenCalled();
                expect(mockEventEmitter.emit).not.toHaveBeenCalled();
            });
        });

        describe('getSharedCaseNotes', () => {
            it('returns case notes when the entire chain belongs to caller tenant (sanity)', async () => {
                mockConsultationRepository.findById.mockResolvedValue(inTenantRoot);
                mockConsultationRepository.findConsultationChain.mockResolvedValue([
                    { id: 'consultation-1', tenantId: 'tenant-1' },
                ]);
                mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                    { id: 'consultation-1', tenantId: 'tenant-1' },
                ]);
                const sharedCaseNotes = [
                    createMockContextItemEntity({
                        id: 'case-note-1',
                        consultationId: 'consultation-1',
                        type: 'CASE_NOTE' as any,
                    }),
                ];
                mockContextItemRepository.findCaseNotesFromChain.mockResolvedValue(sharedCaseNotes);

                const result = await service.getSharedCaseNotes('consultation-1');

                expect(result).toHaveLength(1);
                const passedIds = mockContextItemRepository.findCaseNotesFromChain.mock.calls[0][0] as string[];
                expect(passedIds).toContain('consultation-1');
            });

            it('filters poisoned chain rows to caller tenant before findCaseNotesFromChain', async () => {
                mockConsultationRepository.findById.mockResolvedValue(inTenantRoot);
                mockConsultationRepository.findConsultationChain.mockResolvedValue([
                    { id: 'consultation-1', tenantId: 'tenant-1' },
                    { id: 'child-foreign', tenantId: 'tenant-OTHER' },
                ]);
                mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                    { id: 'consultation-1', tenantId: 'tenant-1' },
                ]);
                mockContextItemRepository.findCaseNotesFromChain.mockResolvedValue([]);

                await service.getSharedCaseNotes('consultation-1');

                const passedIds = mockContextItemRepository.findCaseNotesFromChain.mock.calls[0][0] as string[];
                expect(passedIds).toContain('consultation-1');
                expect(passedIds).not.toContain('child-foreign');
            });
        });

        describe('getAggregateNamedEntities', () => {
            it('scope=chain — filters poisoned chain ids before downstream consultation/per-id fetches', async () => {
                mockConsultationRepository.findById.mockResolvedValue({
                    ...inTenantRoot,
                    id: 'consultation-a',
                });
                mockConsultationRepository.findConsultationChain.mockResolvedValue([
                    { id: 'consultation-a', tenantId: 'tenant-1' },
                    { id: 'consultation-foreign', tenantId: 'tenant-OTHER' },
                ]);
                mockConsultationRepository.findByPatientAndDate.mockResolvedValue([
                    { id: 'consultation-a', tenantId: 'tenant-1' },
                ]);
                mockConsultationRepository.findWithRelations.mockResolvedValueOnce({
                    id: 'consultation-a',
                    tenantId: 'tenant-1',
                    patientId: 'patient-1',
                    appointmentDate: new Date('2026-02-17'),
                    doctorId: 'doctor-a-id',
                    departmentId: 'dept-gen',
                    Doctor: {
                        username: 'dr.smith',
                        UserProfile: { firstName: 'John', lastName: 'Smith' },
                    },
                    Department: { name: 'General' },
                });
                mockContextItemRepository.findSummaries.mockResolvedValue([]);
                mockContextItemRepository.findTranscripts.mockResolvedValue([]);

                await service.getAggregateNamedEntities('consultation-a', 'chain');

                expect(mockConsultationRepository.findWithRelations).toHaveBeenCalledWith('consultation-a');
                expect(mockConsultationRepository.findWithRelations).not.toHaveBeenCalledWith('consultation-foreign');
                expect(mockConsultationRepository.findWithRelations).toHaveBeenCalledTimes(1);
                expect(mockContextItemRepository.findSummaries).toHaveBeenCalledWith('consultation-a');
                expect(mockContextItemRepository.findSummaries).not.toHaveBeenCalledWith('consultation-foreign');
            });

            it('scope=single — extension-scoped findWithRelations + per-id loops return empty for foreign-tenant id', async () => {
                // scope=single bypasses `resolveLinkedConsultationIds`;
                // the W5.4.1 audit-surface comment documents that single-id
                // paths are already covered by the Prisma `tenantScope`
                // extension. This test pins that contract: when the
                // extension scopes the per-id reads to empty (as it does
                // for a foreign-tenant id), the service returns an empty
                // response without surfacing foreign data.
                //
                // NOTE: explicit `mockReset` on the per-id repos to drain
                // any `mockResolvedValueOnce` queue left over from the
                // upstream `getAggregateNamedEntities` test suite —
                // `vi.clearAllMocks()` in `beforeEach` clears call
                // history but NOT the implementation queue, so without
                // this reset a prior queued response can bleed through.
                mockConsultationRepository.findWithRelations.mockReset();
                mockContextItemRepository.findSummaries.mockReset();
                mockContextItemRepository.findTranscripts.mockReset();
                mockNamedEntityRepository.findByContextItem.mockReset();
                mockConsultationRepository.findWithRelations.mockResolvedValue(null);
                mockContextItemRepository.findSummaries.mockResolvedValue([]);
                mockContextItemRepository.findTranscripts.mockResolvedValue([]);
                mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

                const result = await service.getAggregateNamedEntities('consultation-foreign', 'single');

                expect(result.totalCount).toBe(0);
                expect(result.entities).toEqual({});
                expect(result.sources).toEqual([]);
                expect(mockConsultationRepository.findConsultationChain).not.toHaveBeenCalled();
                expect(mockConsultationRepository.findByPatientAndDate).not.toHaveBeenCalled();
            });
        });

        /**
         * TASK-306 W5.7.8 (306-F11) — scope=single broadcast gate.
         *
         * Pre-W5.7.8, `getAggregateNamedEntities(consultationId, 'single')`
         * passed `[consultationId]` straight to the downstream
         * pipeline. The Prisma `tenantScope` extension scopes the
         * per-id reads to empty for a foreign-tenant `consultationId`
         * (so no PHI leaks via `entities` / `sources`), but the
         * `ResourceViewed` broadcast at the end of the method STILL
         * fired with the foreign `consultationId` in the payload — a
         * minor side-channel signal that a Tenant-A user "viewed"
         * Tenant-B's id.
         *
         * The fix pre-fetches the root consultation and short-circuits
         * with an empty response (and NO broadcast) when the root is
         * absent or foreign-tenant. scope=chain is unaffected — its
         * existing early-return at `consultationIds.length === 0`
         * already skips the broadcast on the
         * `resolveLinkedConsultationIds === []` cross-tenant case
         * (W5.4 contract).
         */
        describe('TASK-306 W5.7.8 — getAggregateNamedEntities scope=single broadcast gate', () => {
            it('does NOT broadcast ResourceViewed when scope=single and consultationId is foreign-tenant', async () => {
                mockConsultationRepository.findWithRelations.mockReset();
                mockContextItemRepository.findSummaries.mockReset();
                mockContextItemRepository.findTranscripts.mockReset();
                mockNamedEntityRepository.findByContextItem.mockReset();
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-foreign',
                    tenantId: 'tenant-OTHER',
                    patientId: 'patient-foreign',
                    appointmentDate: new Date('2026-02-17'),
                });

                const result = await service.getAggregateNamedEntities('consultation-foreign', 'single');

                expect(result).toEqual(
                    expect.objectContaining({
                        consultationId: 'consultation-foreign',
                        scope: 'single',
                        entities: {},
                        totalCount: 0,
                        countByClass: {},
                        sources: [],
                    }),
                );
                expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
                    SysEventType.ResourceViewed,
                    expect.anything(),
                );
                // Short-circuit must happen BEFORE the downstream fetches.
                expect(mockConsultationRepository.findWithRelations).not.toHaveBeenCalled();
                expect(mockContextItemRepository.findSummaries).not.toHaveBeenCalled();
            });

            it('broadcasts ResourceViewed when scope=single and consultationId is same-tenant (sanity)', async () => {
                mockConsultationRepository.findWithRelations.mockReset();
                mockContextItemRepository.findSummaries.mockReset();
                mockContextItemRepository.findTranscripts.mockReset();
                mockNamedEntityRepository.findByContextItem.mockReset();
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-a',
                    tenantId: 'tenant-1',
                    patientId: 'patient-1',
                    appointmentDate: new Date('2026-02-17'),
                });
                mockConsultationRepository.findWithRelations.mockResolvedValue({
                    id: 'consultation-a',
                    tenantId: 'tenant-1',
                    patientId: 'patient-1',
                    appointmentDate: new Date('2026-02-17'),
                    doctorId: 'doctor-a-id',
                    departmentId: 'dept-gen',
                    Doctor: { username: 'dr.smith', UserProfile: { firstName: 'John', lastName: 'Smith' } },
                    Department: { name: 'General' },
                });
                mockContextItemRepository.findSummaries.mockResolvedValue([]);
                mockContextItemRepository.findTranscripts.mockResolvedValue([]);
                mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

                await service.getAggregateNamedEntities('consultation-a', 'single');

                expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                    SysEventType.ResourceViewed,
                    expect.objectContaining({
                        data: expect.objectContaining({
                            consultationId: 'consultation-a',
                            scope: 'single',
                        }),
                    }),
                );
            });
        });
    });
});
