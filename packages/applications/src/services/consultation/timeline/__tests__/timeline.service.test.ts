/**
 * TimelineService Unit Tests
 *
 * Tests for the consultation timeline endpoint (ENH-2).
 * Verifies that the service correctly aggregates events from
 * consultations, context items, and named entities into a
 * chronological timeline.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TimelineService } from '../timeline.service';
import { TimelineEventType } from '../dto';

// Mock ClsService
const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

// Mock EventEmitter
const mockEventEmitter = {
    emit: vi.fn(),
};

// Mock ConsultationRepository
const mockConsultationRepository = {
    findById: vi.fn(),
    findConsultationChain: vi.fn(),
    findByPatientAndDate: vi.fn(),
    findWithRelations: vi.fn(),
};

// Mock ContextItemRepository
const mockContextItemRepository = {
    findByConsultation: vi.fn(),
};

// Mock NamedEntityRepository
const mockNamedEntityRepository = {
    findByContextItem: vi.fn(),
};

// Helper: create a mock consultation entity
// Uses 'key' in overrides checks for nullable fields to allow explicit null
const createMockConsultation = (overrides: Record<string, any> = {}) => ({
    id: overrides.id ?? 'consultation-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    patientId: overrides.patientId ?? 'patient-1',
    doctorId: overrides.doctorId ?? 'doctor-1',
    departmentId: 'departmentId' in overrides ? overrides.departmentId : 'dept-1',
    appointmentDate: overrides.appointmentDate ?? new Date('2026-02-17'),
    parentConsultationId: overrides.parentConsultationId ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-02-17T09:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-02-17T09:00:00Z'),
    Doctor: 'Doctor' in overrides ? overrides.Doctor : {
        id: overrides.doctorId ?? 'doctor-1',
        username: 'dr.smith',
        UserProfile: { firstName: 'John', lastName: 'Smith' },
    },
    Department: 'Department' in overrides ? overrides.Department : {
        id: overrides.departmentId ?? 'dept-1',
        code: 'GM',
        name: 'General Medicine',
    },
    ContextItems: overrides.ContextItems ?? [],
});

// Helper: create a mock context item entity
// Uses 'key' in overrides checks for nullable fields to allow explicit null
const createMockContextItem = (overrides: Record<string, any> = {}) => ({
    id: overrides.id ?? 'ctx-1',
    consultationId: overrides.consultationId ?? 'consultation-1',
    type: overrides.type ?? 'TRANSCRIPT',
    source: overrides.source ?? 'TRANSCRIPTION',
    content: 'content' in overrides ? overrides.content : 'Test transcript content',
    currentVersionNumber: overrides.currentVersionNumber ?? 1,
    createdAt: overrides.createdAt ?? new Date('2026-02-17T09:15:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-02-17T09:15:00Z'),
    isSummary: overrides.isSummary ?? false,
    isFinalSummary: overrides.isFinalSummary ?? false,
    isPreSummary: overrides.isPreSummary ?? false,
    isTranscript: overrides.isTranscript ?? true,
    isAiGenerated: overrides.isAiGenerated ?? false,
    SummaryMeta: 'SummaryMeta' in overrides ? overrides.SummaryMeta : null,
});

// Helper: create a mock named entity
const createMockNamedEntity = (overrides: Record<string, any> = {}) => ({
    id: overrides.id ?? 'ne-1',
    contextItemId: overrides.contextItemId ?? 'ctx-1',
    text: overrides.text ?? 'Aspirin',
    className: overrides.className ?? 'MEDICATION',
    createdAt: overrides.createdAt ?? new Date('2026-02-17T09:20:00Z'),
});

let service: TimelineService;

beforeEach(() => {
    vi.clearAllMocks();

    // Default CLS values
    mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-1';
        if (key === 'user') return { id: 'doctor-1', tenantId: 'tenant-1' };
        return undefined;
    });

    service = new TimelineService(
        mockConsultationRepository as any,
        mockContextItemRepository as any,
        mockNamedEntityRepository as any,
        mockEventEmitter as any,
        mockClsService as any,
    );
});

describe('TimelineService', () => {
    describe('getTimeline', () => {
        it('should return empty timeline when consultation is not found', async () => {
            mockConsultationRepository.findById.mockResolvedValue(null);

            const result = await service.getTimeline('nonexistent', 'chain');

            expect(result.events).toHaveLength(0);
            expect(result.totalEvents).toBe(0);
            expect(result.sources).toHaveLength(0);
            expect(result.scope).toBe('chain');
        });

        it('should return timeline for a single consultation (scope=single)', async () => {
            const consultation = createMockConsultation();
            const transcript = createMockContextItem();

            mockConsultationRepository.findWithRelations.mockResolvedValue(consultation);
            mockContextItemRepository.findByConsultation.mockResolvedValue([transcript]);
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'single');

            expect(result.scope).toBe('single');
            expect(result.consultationId).toBe('consultation-1');
            expect(result.sources).toHaveLength(1);
            expect(result.sources[0].consultationId).toBe('consultation-1');
            expect(result.sources[0].department).toBe('General Medicine');

            // Should have: 1 consultation_opened + 1 transcription_completed
            const openEvents = result.events.filter(e => e.type === TimelineEventType.ConsultationOpened);
            const transcriptEvents = result.events.filter(e => e.type === TimelineEventType.TranscriptionCompleted);

            expect(openEvents).toHaveLength(1);
            expect(transcriptEvents).toHaveLength(1);
            expect(transcriptEvents[0].wordCount).toBe(3); // "Test transcript content"
        });

        it('should include events from chain + same-day consultations (scope=chain)', async () => {
            const consultationA = createMockConsultation({
                id: 'consultation-A',
                doctorId: 'doctor-A',
                departmentId: 'dept-A',
                Doctor: { id: 'doctor-A', username: 'dr.a', UserProfile: { firstName: 'Alice', lastName: 'Adams' } },
                Department: { id: 'dept-A', name: 'General Medicine' },
                createdAt: new Date('2026-02-17T09:00:00Z'),
            });
            const consultationB = createMockConsultation({
                id: 'consultation-B',
                doctorId: 'doctor-B',
                departmentId: 'dept-B',
                Doctor: { id: 'doctor-B', username: 'dr.b', UserProfile: { firstName: 'Bob', lastName: 'Brown' } },
                Department: { id: 'dept-B', name: 'Hematology' },
                createdAt: new Date('2026-02-17T10:00:00Z'),
            });

            // Chain resolution
            mockConsultationRepository.findById.mockResolvedValue(consultationA);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([consultationA]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([consultationA, consultationB]);

            // Relations
            mockConsultationRepository.findWithRelations
                .mockResolvedValueOnce(consultationA)
                .mockResolvedValueOnce(consultationB);

            // Context items
            const transcriptA = createMockContextItem({
                id: 'ctx-A',
                consultationId: 'consultation-A',
                createdAt: new Date('2026-02-17T09:15:00Z'),
            });
            const summaryB = createMockContextItem({
                id: 'ctx-B',
                consultationId: 'consultation-B',
                type: 'RAW_SUMMARY',
                isTranscript: false,
                isSummary: true,
                isFinalSummary: true,
                content: 'Summary of consultation B findings',
                SummaryMeta: { aiModelId: 'gpt-4o' },
                createdAt: new Date('2026-02-17T10:30:00Z'),
            });

            mockContextItemRepository.findByConsultation
                .mockResolvedValueOnce([transcriptA])  // For events of consultation-A
                .mockResolvedValueOnce([summaryB])      // For events of consultation-B
                .mockResolvedValueOnce([transcriptA])   // For NER check of consultation-A
                .mockResolvedValueOnce([summaryB]);     // For NER check of consultation-B

            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-A', 'chain');

            expect(result.scope).toBe('chain');
            expect(result.sources).toHaveLength(2);

            // Should have: 2 consultation_opened + 1 transcript + 1 summary = 4
            expect(result.events.length).toBeGreaterThanOrEqual(4);

            // Events should be chronologically sorted
            for (let i = 1; i < result.events.length; i++) {
                expect(new Date(result.events[i].timestamp).getTime())
                    .toBeGreaterThanOrEqual(new Date(result.events[i - 1].timestamp).getTime());
            }

            // Check departments are populated
            const depts = new Set(result.events.map(e => e.department).filter(Boolean));
            expect(depts).toContain('General Medicine');
            expect(depts).toContain('Hematology');
        });

        it('should include NER extraction events when entities exist', async () => {
            const consultation = createMockConsultation();
            const summary = createMockContextItem({
                id: 'ctx-summary',
                type: 'RAW_SUMMARY',
                isSummary: true,
                isFinalSummary: true,
                isTranscript: false,
                content: 'Summary content',
                createdAt: new Date('2026-02-17T09:20:00Z'),
            });

            mockConsultationRepository.findById.mockResolvedValue(consultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([consultation]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([consultation]);
            mockConsultationRepository.findWithRelations.mockResolvedValue(consultation);

            mockContextItemRepository.findByConsultation
                .mockResolvedValueOnce([summary])   // For events
                .mockResolvedValueOnce([summary]);  // For NER check

            const entities = [
                createMockNamedEntity({ id: 'ne-1', text: 'Aspirin', className: 'MEDICATION', createdAt: new Date('2026-02-17T09:25:00Z') }),
                createMockNamedEntity({ id: 'ne-2', text: 'Diabetes', className: 'CONDITION', createdAt: new Date('2026-02-17T09:25:01Z') }),
                createMockNamedEntity({ id: 'ne-3', text: 'CBC', className: 'PROCEDURE', createdAt: new Date('2026-02-17T09:25:02Z') }),
            ];
            mockNamedEntityRepository.findByContextItem.mockResolvedValue(entities);

            const result = await service.getTimeline('consultation-1', 'chain');

            const nerEvents = result.events.filter(e => e.type === TimelineEventType.NerExtracted);
            expect(nerEvents).toHaveLength(1);
            expect(nerEvents[0].entityCount).toBe(3);
            expect(nerEvents[0].contextItemId).toBe('ctx-summary');
        });

        it('should include update events for versioned context items', async () => {
            const consultation = createMockConsultation();
            const updatedSummary = createMockContextItem({
                id: 'ctx-summary',
                type: 'RAW_SUMMARY',
                isSummary: true,
                isFinalSummary: true,
                isTranscript: false,
                content: 'Updated summary',
                currentVersionNumber: 3,
                createdAt: new Date('2026-02-17T09:20:00Z'),
                updatedAt: new Date('2026-02-17T10:00:00Z'),
            });

            mockConsultationRepository.findById.mockResolvedValue(consultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([consultation]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([consultation]);
            mockConsultationRepository.findWithRelations.mockResolvedValue(consultation);

            mockContextItemRepository.findByConsultation
                .mockResolvedValueOnce([updatedSummary])
                .mockResolvedValueOnce([updatedSummary]);
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');

            const summaryEvents = result.events.filter(e => e.type === TimelineEventType.SummaryGenerated);
            const updateEvents = result.events.filter(e => e.type === TimelineEventType.SummaryUpdated);

            expect(summaryEvents).toHaveLength(1);
            expect(updateEvents).toHaveLength(1);
            expect(updateEvents[0].versionNumber).toBe(3);
        });

        it('should populate word count for transcript events', async () => {
            const consultation = createMockConsultation();
            const transcript = createMockContextItem({
                content: 'The patient presented with fever and cough lasting three days',
            });

            mockConsultationRepository.findById.mockResolvedValue(consultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([consultation]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([consultation]);
            mockConsultationRepository.findWithRelations.mockResolvedValue(consultation);
            mockContextItemRepository.findByConsultation
                .mockResolvedValueOnce([transcript])
                .mockResolvedValueOnce([transcript]);
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');
            const transcriptEvent = result.events.find(e => e.type === TimelineEventType.TranscriptionCompleted);

            expect(transcriptEvent?.wordCount).toBe(10);
        });

        it('should populate AI model for summary events', async () => {
            const consultation = createMockConsultation();
            const summary = createMockContextItem({
                type: 'RAW_SUMMARY',
                isSummary: true,
                isFinalSummary: true,
                isTranscript: false,
                SummaryMeta: { aiModelId: 'gpt-4o-mini' },
                createdAt: new Date('2026-02-17T09:30:00Z'),
            });

            mockConsultationRepository.findById.mockResolvedValue(consultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([consultation]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([consultation]);
            mockConsultationRepository.findWithRelations.mockResolvedValue(consultation);
            mockContextItemRepository.findByConsultation
                .mockResolvedValueOnce([summary])
                .mockResolvedValueOnce([summary]);
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');
            const summaryEvent = result.events.find(e => e.type === TimelineEventType.SummaryGenerated);

            expect(summaryEvent?.aiModel).toBe('gpt-4o-mini');
        });

        it('should handle case notes and worknotes as context_added events', async () => {
            const consultation = createMockConsultation();
            const caseNote = createMockContextItem({
                id: 'ctx-cn',
                type: 'CASE_NOTE',
                isTranscript: false,
                isSummary: false,
                content: 'Patient history notes',
                createdAt: new Date('2026-02-17T09:05:00Z'),
            });
            const worknote = createMockContextItem({
                id: 'ctx-wn',
                type: 'WORKNOTE',
                isTranscript: false,
                isSummary: false,
                content: 'Internal clinical notes',
                createdAt: new Date('2026-02-17T09:10:00Z'),
            });

            mockConsultationRepository.findById.mockResolvedValue(consultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([consultation]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([consultation]);
            mockConsultationRepository.findWithRelations.mockResolvedValue(consultation);
            mockContextItemRepository.findByConsultation
                .mockResolvedValueOnce([caseNote, worknote])
                .mockResolvedValueOnce([caseNote, worknote]);
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');
            const contextEvents = result.events.filter(e => e.type === TimelineEventType.ContextAdded);

            expect(contextEvents).toHaveLength(2);
            expect(contextEvents[0].contextType).toBe('CASE_NOTE');
            expect(contextEvents[1].contextType).toBe('WORKNOTE');
        });

        it('should handle pre-summary events', async () => {
            const consultation = createMockConsultation();
            const preSummary = createMockContextItem({
                type: 'PRE_SUMMARY',
                isSummary: true,
                isFinalSummary: false,
                isPreSummary: true,
                isTranscript: false,
                content: 'AI pre-summary of case notes',
                createdAt: new Date('2026-02-17T09:25:00Z'),
            });

            mockConsultationRepository.findById.mockResolvedValue(consultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([consultation]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([consultation]);
            mockConsultationRepository.findWithRelations.mockResolvedValue(consultation);
            mockContextItemRepository.findByConsultation
                .mockResolvedValueOnce([preSummary])
                .mockResolvedValueOnce([preSummary]);
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');
            const preSummaryEvents = result.events.filter(e => e.type === TimelineEventType.PreSummaryGenerated);

            expect(preSummaryEvents).toHaveLength(1);
        });

        it('should broadcast SysEvent when timeline is viewed', async () => {
            const consultation = createMockConsultation();

            mockConsultationRepository.findById.mockResolvedValue(consultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([consultation]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([consultation]);
            mockConsultationRepository.findWithRelations.mockResolvedValue(consultation);
            mockContextItemRepository.findByConsultation.mockResolvedValue([]);

            await service.getTimeline('consultation-1', 'chain');

            expect(mockEventEmitter.emit).toHaveBeenCalled();
        });

        it('should format doctor name from UserProfile (first + last)', async () => {
            const consultation = createMockConsultation({
                Doctor: {
                    id: 'doctor-1',
                    username: 'dr.smith',
                    UserProfile: { firstName: 'Jane', lastName: 'Smith' },
                },
            });

            mockConsultationRepository.findById.mockResolvedValue(consultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([consultation]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([consultation]);
            mockConsultationRepository.findWithRelations.mockResolvedValue(consultation);
            mockContextItemRepository.findByConsultation.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');

            expect(result.sources[0].doctor).toBe('Jane Smith');
            expect(result.events[0].doctor).toBe('Jane Smith');
        });

        it('should fall back to username when no UserProfile', async () => {
            const consultation = createMockConsultation({
                Doctor: {
                    id: 'doctor-1',
                    username: 'dr.jones',
                    UserProfile: null,
                },
            });

            mockConsultationRepository.findById.mockResolvedValue(consultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([consultation]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([consultation]);
            mockConsultationRepository.findWithRelations.mockResolvedValue(consultation);
            mockContextItemRepository.findByConsultation.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');

            expect(result.sources[0].doctor).toBe('dr.jones');
        });
    });

    // ============================================
    // Edge Cases — TDD RED/GREEN verification
    // ============================================
    describe('edge cases', () => {
        // Helper to set up chain resolution for a single consultation
        const setupSingleConsultationChain = (consultation: any) => {
            mockConsultationRepository.findById.mockResolvedValue(consultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([consultation]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([consultation]);
            mockConsultationRepository.findWithRelations.mockResolvedValue(consultation);
        };

        it('should handle consultation with null Department (no department assigned)', async () => {
            const consultation = createMockConsultation({
                departmentId: null,
                Department: null,
            });
            setupSingleConsultationChain(consultation);
            mockContextItemRepository.findByConsultation.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');

            expect(result.sources[0].department).toBeUndefined();
            const openEvent = result.events.find(e => e.type === TimelineEventType.ConsultationOpened);
            expect(openEvent?.department).toBeUndefined();
            expect(openEvent?.departmentId).toBeUndefined();
        });

        it('should handle consultation with null Doctor relation', async () => {
            const consultation = createMockConsultation({
                Doctor: null,
            });
            setupSingleConsultationChain(consultation);
            mockContextItemRepository.findByConsultation.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');

            expect(result.sources[0].doctor).toBeUndefined();
            const openEvent = result.events.find(e => e.type === TimelineEventType.ConsultationOpened);
            expect(openEvent?.doctor).toBeUndefined();
            // doctorId should still be populated from the consultation entity itself
            expect(openEvent?.doctorId).toBe('doctor-1');
        });

        it('should return undefined wordCount for transcript with null content', async () => {
            const consultation = createMockConsultation();
            const transcript = createMockContextItem({
                content: null,
                isTranscript: true,
            });
            setupSingleConsultationChain(consultation);
            mockContextItemRepository.findByConsultation
                .mockResolvedValueOnce([transcript])
                .mockResolvedValueOnce([transcript]);
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');
            const transcriptEvent = result.events.find(e => e.type === TimelineEventType.TranscriptionCompleted);

            expect(transcriptEvent?.wordCount).toBeUndefined();
        });

        it('should return undefined wordCount for transcript with empty string content', async () => {
            const consultation = createMockConsultation();
            const transcript = createMockContextItem({
                content: '',
                isTranscript: true,
            });
            setupSingleConsultationChain(consultation);
            mockContextItemRepository.findByConsultation
                .mockResolvedValueOnce([transcript])
                .mockResolvedValueOnce([transcript]);
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');
            const transcriptEvent = result.events.find(e => e.type === TimelineEventType.TranscriptionCompleted);

            expect(transcriptEvent?.wordCount).toBeUndefined();
        });

        it('should return undefined wordCount for transcript with whitespace-only content', async () => {
            const consultation = createMockConsultation();
            const transcript = createMockContextItem({
                content: '   \n\t  ',
                isTranscript: true,
            });
            setupSingleConsultationChain(consultation);
            mockContextItemRepository.findByConsultation
                .mockResolvedValueOnce([transcript])
                .mockResolvedValueOnce([transcript]);
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');
            const transcriptEvent = result.events.find(e => e.type === TimelineEventType.TranscriptionCompleted);

            // Whitespace-only should have wordCount 0 (after trim + split + filter)
            expect(transcriptEvent?.wordCount).toBe(0);
        });

        it('should map MODIFIED_SUMMARY to SummaryGenerated event type', async () => {
            const consultation = createMockConsultation();
            const modifiedSummary = createMockContextItem({
                type: 'MODIFIED_SUMMARY',
                isSummary: true,
                isFinalSummary: true,
                isTranscript: false,
                content: 'Doctor-edited summary',
                createdAt: new Date('2026-02-17T10:00:00Z'),
            });
            setupSingleConsultationChain(consultation);
            mockContextItemRepository.findByConsultation
                .mockResolvedValueOnce([modifiedSummary])
                .mockResolvedValueOnce([modifiedSummary]);
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');
            const summaryEvents = result.events.filter(e => e.type === TimelineEventType.SummaryGenerated);

            expect(summaryEvents).toHaveLength(1);
            expect(summaryEvents[0].contextType).toBe('MODIFIED_SUMMARY');
        });

        it('should NOT query NER for CASE_NOTE context items', async () => {
            const consultation = createMockConsultation();
            const caseNote = createMockContextItem({
                type: 'CASE_NOTE',
                isSummary: false,
                isTranscript: false,
            });
            setupSingleConsultationChain(consultation);
            mockContextItemRepository.findByConsultation
                .mockResolvedValueOnce([caseNote])
                .mockResolvedValueOnce([caseNote]);

            await service.getTimeline('consultation-1', 'chain');

            // findByContextItem should NOT be called because CASE_NOTE is
            // neither isSummary nor isTranscript
            expect(mockNamedEntityRepository.findByContextItem).not.toHaveBeenCalled();
        });

        it('should guarantee totalEvents equals events.length', async () => {
            const consultation = createMockConsultation();
            const items = [
                createMockContextItem({ id: 'ctx-1', type: 'TRANSCRIPT', isTranscript: true, createdAt: new Date('2026-02-17T09:10:00Z') }),
                createMockContextItem({ id: 'ctx-2', type: 'CASE_NOTE', isTranscript: false, isSummary: false, createdAt: new Date('2026-02-17T09:15:00Z') }),
                createMockContextItem({ id: 'ctx-3', type: 'RAW_SUMMARY', isTranscript: false, isSummary: true, isFinalSummary: true, createdAt: new Date('2026-02-17T09:20:00Z') }),
            ];
            setupSingleConsultationChain(consultation);
            mockContextItemRepository.findByConsultation.mockResolvedValue(items);
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');

            expect(result.totalEvents).toBe(result.events.length);
        });

        it('should default scope to chain when not provided', async () => {
            const consultation = createMockConsultation();
            setupSingleConsultationChain(consultation);
            mockContextItemRepository.findByConsultation.mockResolvedValue([]);

            // Call without scope parameter — should default to 'chain'
            const result = await service.getTimeline('consultation-1');

            expect(result.scope).toBe('chain');
            // Should have called findById (chain resolution), not just findWithRelations (single)
            expect(mockConsultationRepository.findById).toHaveBeenCalledWith('consultation-1');
        });

        it('should handle consultation where findWithRelations returns null (deleted mid-request)', async () => {
            const consultation = createMockConsultation();
            mockConsultationRepository.findById.mockResolvedValue(consultation);
            mockConsultationRepository.findConsultationChain.mockResolvedValue([consultation]);
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue([consultation]);
            // findWithRelations returns null — consultation was deleted between resolve and fetch
            mockConsultationRepository.findWithRelations.mockResolvedValue(null);

            const result = await service.getTimeline('consultation-1', 'chain');

            // Should gracefully return empty — no consultations resolved to relations
            expect(result.sources).toHaveLength(0);
            expect(result.events).toHaveLength(0);
        });

        it('should handle zero context items for a consultation', async () => {
            const consultation = createMockConsultation();
            setupSingleConsultationChain(consultation);
            mockContextItemRepository.findByConsultation.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');

            // Should have exactly 1 event: consultation_opened
            expect(result.events).toHaveLength(1);
            expect(result.events[0].type).toBe(TimelineEventType.ConsultationOpened);
        });

        it('should not emit update event when currentVersionNumber is 1 even if updatedAt > createdAt', async () => {
            const consultation = createMockConsultation();
            const item = createMockContextItem({
                type: 'CASE_NOTE',
                isSummary: false,
                isTranscript: false,
                currentVersionNumber: 1,
                createdAt: new Date('2026-02-17T09:00:00Z'),
                updatedAt: new Date('2026-02-17T10:00:00Z'), // updatedAt > createdAt
            });
            setupSingleConsultationChain(consultation);
            mockContextItemRepository.findByConsultation
                .mockResolvedValueOnce([item])
                .mockResolvedValueOnce([item]);
            mockNamedEntityRepository.findByContextItem.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');

            const updateEvents = result.events.filter(
                e => e.type === TimelineEventType.ContextUpdated || e.type === TimelineEventType.SummaryUpdated
            );
            expect(updateEvents).toHaveLength(0);
        });

        it('should format doctor name with only firstName (no lastName)', async () => {
            const consultation = createMockConsultation({
                Doctor: {
                    id: 'doctor-1',
                    username: 'dr.solo',
                    UserProfile: { firstName: 'Madonna', lastName: null },
                },
            });
            setupSingleConsultationChain(consultation);
            mockContextItemRepository.findByConsultation.mockResolvedValue([]);

            const result = await service.getTimeline('consultation-1', 'chain');

            expect(result.sources[0].doctor).toBe('Madonna');
        });
    });
});
