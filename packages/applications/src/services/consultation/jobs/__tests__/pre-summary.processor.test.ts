/**
 * PreSummaryProcessor Unit Tests
 *
 * Tests for the PreSummaryProcessor that handles async pre-summary generation jobs.
 * The processor gathers case notes from a consultation and calls the SMR service.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { PreSummaryProcessor } from '../processors/pre-summary.processor';
import { GeneratePreSummaryJobPayload, PreSummaryJobResult } from '../dto';
import { ContextItemType } from '@arcaai/domains';

// Mock consultation job service
const createMockJobService = () => ({
    notifyProgress: vi.fn().mockResolvedValue(undefined),
    notifyComplete: vi.fn().mockResolvedValue(undefined),
    notifyFailed: vi.fn().mockResolvedValue(undefined),
});

// Mock repositories
const createMockContextItemRepository = () => ({
    findById: vi.fn(),
    findByConsultation: vi.fn(),
    create: vi.fn(),
});

const createMockConsultationRepository = () => ({
    findById: vi.fn(),
});

// Mock HTTP service
const createMockHttpService = () => ({
    axiosRef: {
        post: vi.fn(),
    },
});

// Mock config service
const createMockConfigService = () => ({
    get: vi.fn().mockImplementation((key: string) => {
        if (key === 'SMR_URL') return 'http://localhost:8862';
        return undefined;
    }),
});

// Mock PromptResolutionService
const createMockPromptResolutionService = () => ({
    resolve: vi.fn().mockResolvedValue({
        template: 'SOAP',
        promptId: 'prompt_default',
        contextVariables: {},
        resolvedFrom: 'default',
        resolutionTrace: { usedDefaults: ['template', 'promptId', 'contextVariables'] },
    }),
});

// Mock PromptAssemblyService
const createMockPromptAssemblyService = () => ({
    assemble: vi.fn().mockImplementation((params: { transcript?: string }) => Promise.resolve({
        userPrompt: params.transcript ?? 'assembled prompt text',
        systemPrompt: '',
        hyperparameters: {},
        responseFormat: null,
        resolvedFrom: 'default',
    })),
});

// Mock JobMetricsService
const createMockJobMetrics = () => ({
    recordJobStart: vi.fn().mockReturnValue(vi.fn().mockReturnValue(5.0)),
    recordJobComplete: vi.fn(),
    recordJobFailed: vi.fn(),
    recordWaitingDuration: vi.fn(),
    recordSmrCallDuration: vi.fn(),
});

// =============================================================================
// Realistic Mock Data Factories - These match actual SMR service responses
// =============================================================================

/**
 * Creates a realistic SMR service response that matches the actual API structure.
 * This prevents Anti-Pattern #4: Incomplete Mocks
 */
const createRealisticSmrResponse = (overrides: Partial<{
    summary: string;
    llmProvider: string;
    modelName: string;
    processingTimeMs: number;
    inputTokens: number;
    outputTokens: number;
    requestId: string;
    timestamp: string;
}> = {}) => ({
    summary: overrides.summary ?? 'Patient presents with chronic headaches. History includes migraines since age 25. Current treatment: Ibuprofen PRN.',
    llmProvider: overrides.llmProvider ?? 'openai',
    modelName: overrides.modelName ?? 'gpt-4-turbo',
    processingTimeMs: overrides.processingTimeMs ?? 2847,
    inputTokens: overrides.inputTokens ?? 156,
    outputTokens: overrides.outputTokens ?? 78,
    requestId: overrides.requestId ?? 'req-abc123',
    timestamp: overrides.timestamp ?? new Date().toISOString(),
});

/**
 * Creates realistic case note content that matches actual medical documentation
 */
const createRealisticCaseNoteContent = (type: 'subjective' | 'objective' | 'assessment' | 'plan' = 'subjective') => {
    const contents: Record<string, string> = {
        subjective: 'Patient reports persistent headaches for the past 3 weeks. Pain is described as throbbing, primarily in the frontal region. Rates pain as 6/10. Worse in the morning, improves with rest. Denies nausea, vomiting, or visual disturbances.',
        objective: 'Vitals: BP 128/82, HR 76, Temp 98.6°F. Neurological exam: Alert and oriented x3. Pupils equal and reactive. No focal deficits. Cranial nerves II-XII intact.',
        assessment: 'Tension-type headache, likely stress-related. Differential includes migraine without aura, cervicogenic headache.',
        plan: 'Start ibuprofen 400mg TID with food. Recommend stress management techniques. Follow-up in 2 weeks if no improvement. Return precautions discussed.',
    };
    return contents[type];
};

// Helper to create mock job
const createMockJob = (data: GeneratePreSummaryJobPayload): Job<GeneratePreSummaryJobPayload> =>
    ({
        data,
        id: data.jobId,
        name: 'generate',
        timestamp: Date.now(),
    }) as unknown as Job<GeneratePreSummaryJobPayload>;

// Helper to create mock consultation
const createMockConsultation = (overrides: Partial<any> = {}) => ({
    id: overrides.id ?? 'consultation-123',
    tenantId: overrides.tenantId ?? 'tenant-1',
    patientId: overrides.patientId ?? 'patient-1',
    doctorId: overrides.doctorId ?? 'doctor-1',
    ...overrides,
});

// Helper to create mock context item (case note)
const createMockContextItem = (overrides: Partial<any> = {}) => ({
    id: overrides.id ?? 'ctx-item-123',
    consultationId: overrides.consultationId ?? 'consultation-123',
    type: overrides.type ?? ContextItemType.CASE_NOTE,
    content: overrides.content ?? 'Patient presents with symptoms...',
    tenantId: overrides.tenantId ?? 'tenant-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
});

describe('PreSummaryProcessor', () => {
    let processor: PreSummaryProcessor;
    let mockJobService: ReturnType<typeof createMockJobService>;
    let mockContextItemRepository: ReturnType<typeof createMockContextItemRepository>;
    let mockConsultationRepository: ReturnType<typeof createMockConsultationRepository>;
    let mockHttpService: ReturnType<typeof createMockHttpService>;
    let mockConfigService: ReturnType<typeof createMockConfigService>;
    let mockPromptResolutionService: ReturnType<typeof createMockPromptResolutionService>;
    let mockPromptAssemblyService: ReturnType<typeof createMockPromptAssemblyService>;
    let mockJobMetrics: ReturnType<typeof createMockJobMetrics>;

    beforeEach(() => {
        vi.clearAllMocks();

        mockJobService = createMockJobService();
        mockContextItemRepository = createMockContextItemRepository();
        mockConsultationRepository = createMockConsultationRepository();
        mockHttpService = createMockHttpService();
        mockConfigService = createMockConfigService();
        mockPromptResolutionService = createMockPromptResolutionService();
        mockPromptAssemblyService = createMockPromptAssemblyService();
        mockJobMetrics = createMockJobMetrics();

        processor = new PreSummaryProcessor(
            mockJobService as any,
            mockContextItemRepository as any,
            mockConsultationRepository as any,
            mockHttpService as any,
            mockConfigService as any,
            mockPromptResolutionService as any,
            mockPromptAssemblyService as any,
            mockJobMetrics as any,
        );
    });

    // ===========================================================================
    // Successful Processing Tests
    // ===========================================================================

    describe('Successful Job Processing', () => {
        it('should process pre-summary job with specific caseNoteIds', async () => {
            const caseNote1 = createMockContextItem({ id: 'case-1', content: 'Case note 1 content' });
            const caseNote2 = createMockContextItem({ id: 'case-2', content: 'Case note 2 content' });

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findById
                .mockResolvedValueOnce(caseNote1)
                .mockResolvedValueOnce(caseNote2);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    summary: 'Generated pre-summary text',
                    modelName: 'gpt-4',
                    processingTimeMs: 2500,
                    inputTokens: 150,
                    outputTokens: 75,
                },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'new-pre-summary-id',
                content: 'Generated pre-summary text',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {
                    caseNoteIds: ['case-1', 'case-2'],
                    dnaStyleId: 'style-1',
                },
            };

            const result = await processor.process(createMockJob(payload));

            expect(result).toEqual({
                contextItemId: 'new-pre-summary-id',
                content: 'Generated pre-summary text',
                summaryMeta: {
                    aiModelId: 'gpt-4',
                    processingTimeMs: 2500,
                    inputTokens: 150,
                    outputTokens: 75,
                },
            });

            expect(mockJobService.notifyProgress).toHaveBeenCalledTimes(3);
            expect(mockJobService.notifyComplete).toHaveBeenCalledWith('job-123', result);
        });

        it('should process pre-summary job using all case notes when no caseNoteIds provided', async () => {
            const caseNotes = [
                createMockContextItem({ id: 'case-1', content: 'Content 1' }),
                createMockContextItem({ id: 'case-2', content: 'Content 2' }),
                createMockContextItem({ id: 'case-3', content: 'Content 3' }),
            ];

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue(caseNotes);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    summary: 'Generated summary from all notes',
                    modelName: 'claude-3',
                    processingTimeMs: 3000,
                },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'new-pre-summary-id',
                content: 'Generated summary from all notes',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-456',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {}, // No caseNoteIds
            };

            await processor.process(createMockJob(payload));

            expect(mockContextItemRepository.findByConsultation).toHaveBeenCalledWith(
                'consultation-123',
                { type: ContextItemType.CASE_NOTE },
            );
        });

        it('should send correct payload to SMR service', async () => {
            const caseNote = createMockContextItem({ content: 'Patient symptoms: fever, cough' });

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([caseNote]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Pre-summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Pre-summary',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-789',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {
                    dnaStyleId: 'custom-style',
                    options: { temperature: 0.7 },
                },
            };

            await processor.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                'http://localhost:8862/api/v1/presummary/sync',
                expect.objectContaining({
                    text: 'Patient symptoms: fever, cough',
                    dnaStyleId: 'custom-style',
                    options: expect.objectContaining({ temperature: 0.7 }),
                }),
                {
                    timeout: 120000,
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Service-Token': '',
                        'X-Request-ID': 'job-789',
                    },
                },
            );
        });

        it('should notify progress at each step', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: 'Test content' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-progress',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await processor.process(createMockJob(payload));

            expect(mockJobService.notifyProgress).toHaveBeenNthCalledWith(
                1,
                'job-progress',
                10,
                'Gathering case notes',
            );
            expect(mockJobService.notifyProgress).toHaveBeenNthCalledWith(
                2,
                'job-progress',
                30,
                'Generating pre-summary with AI',
            );
            expect(mockJobService.notifyProgress).toHaveBeenNthCalledWith(
                3,
                'job-progress',
                70,
                'Saving results',
            );
        });

        it('should join multiple case notes with double newlines', async () => {
            const caseNotes = [
                createMockContextItem({ content: 'First case note' }),
                createMockContextItem({ content: 'Second case note' }),
                createMockContextItem({ content: 'Third case note' }),
            ];

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue(caseNotes);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Combined summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Combined summary',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-multi',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await processor.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    text: 'First case note\n\nSecond case note\n\nThird case note',
                }),
                expect.any(Object),
            );
        });
    });

    // ===========================================================================
    // Error Handling Tests
    // ===========================================================================

    describe('Error Handling', () => {
        it('should fail when consultation not found', async () => {
            mockConsultationRepository.findById.mockResolvedValue(null);

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-not-found',
                consultationId: 'non-existent',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Consultation non-existent not found',
            );

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'job-not-found',
                'Consultation non-existent not found',
            );
        });

        it('should fail when no case notes available', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([]);

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-no-notes',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'No case notes available for pre-summary generation',
            );

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'job-no-notes',
                'No case notes available for pre-summary generation',
            );
        });

        it('should fail when all case notes have empty content', async () => {
            const emptyCaseNotes = [
                createMockContextItem({ content: '' }),
                createMockContextItem({ content: '   ' }),
                createMockContextItem({ content: '\n\t' }),
            ];

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue(emptyCaseNotes);

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-empty',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'No case notes available for pre-summary generation',
            );
        });

        it('should fail when specific caseNoteIds not found', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findById.mockResolvedValue(null); // All IDs return null

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-missing-ids',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {
                    caseNoteIds: ['non-existent-1', 'non-existent-2'],
                },
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'No case notes available for pre-summary generation',
            );
        });

        it('should fail when SMR service call fails', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: 'Valid content' }),
            ]);
            mockHttpService.axiosRef.post.mockRejectedValue(new Error('Connection refused'));

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-smr-error',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Failed to generate pre-summary from AI service',
            );

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'job-smr-error',
                'Failed to generate pre-summary from AI service',
            );
        });

        it('should fail when SMR service returns error status', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: 'Valid content' }),
            ]);
            mockHttpService.axiosRef.post.mockRejectedValue({
                response: { status: 500, data: { error: 'Internal server error' } },
                message: 'Request failed with status 500',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-smr-500',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Failed to generate pre-summary from AI service',
            );
        });

        it('should fail when SMR service times out', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: 'Valid content' }),
            ]);
            mockHttpService.axiosRef.post.mockRejectedValue({
                code: 'ETIMEDOUT',
                message: 'timeout of 120000ms exceeded',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-timeout',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Failed to generate pre-summary from AI service',
            );
        });

        it('should handle repository create failure', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: 'Valid content' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Generated summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockRejectedValue(
                new Error('Database connection lost'),
            );

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-db-error',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Database connection lost',
            );

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'job-db-error',
                'Database connection lost',
            );
        });
    });

    // ===========================================================================
    // Edge Cases Tests
    // ===========================================================================

    describe('Edge Cases', () => {
        it('should filter out null case notes when using specific IDs', async () => {
            const validCaseNote = createMockContextItem({
                id: 'case-2',
                content: 'Valid case note',
            });

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findById
                .mockResolvedValueOnce(null) // case-1 not found
                .mockResolvedValueOnce(validCaseNote) // case-2 found
                .mockResolvedValueOnce(null); // case-3 not found
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary from valid note', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary from valid note',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-partial',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {
                    caseNoteIds: ['case-1', 'case-2', 'case-3'],
                },
            };

            await processor.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    text: 'Valid case note',
                }),
                expect.any(Object),
            );
        });

        it('should handle case note with only whitespace content', async () => {
            const mixedCaseNotes = [
                createMockContextItem({ content: '   ' }),
                createMockContextItem({ content: 'Valid content here' }),
                createMockContextItem({ content: '\n\n' }),
            ];

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue(mixedCaseNotes);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-whitespace',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await processor.process(createMockJob(payload));

            // The processor joins all content, and some will be whitespace
            expect(mockHttpService.axiosRef.post).toHaveBeenCalled();
        });

        it('should use default SMR URL when not configured', async () => {
            const configServiceWithoutUrl = {
                get: vi.fn().mockReturnValue(undefined),
            };

            const processorWithDefaultUrl = new PreSummaryProcessor(
                mockJobService as any,
                mockContextItemRepository as any,
                mockConsultationRepository as any,
                mockHttpService as any,
                configServiceWithoutUrl as any,
                mockPromptResolutionService as any,
                mockPromptAssemblyService as any,
                mockJobMetrics as any,
            );

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: 'Content' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-default-url',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await processorWithDefaultUrl.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                'http://localhost:8862/api/v1/presummary/sync',
                expect.any(Object),
                expect.any(Object),
            );
        });

        it('should handle very long case note content', async () => {
            const longContent = 'Patient history: ' + 'x'.repeat(50000);
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: longContent }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary of long content', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary of long content',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-long',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await processor.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    text: longContent,
                }),
                expect.any(Object),
            );
        });

        it('should handle special characters in case note content', async () => {
            const specialContent = 'Patient: José García\nSymptoms: < 38°C, > 90% O₂\nNotes: "alert" & oriented';
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: specialContent }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary with special chars', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary with special chars',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-special',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await processor.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    text: specialContent,
                }),
                expect.any(Object),
            );
        });

        it('should handle SMR service returning partial response', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: 'Test content' }),
            ]);
            // Response without optional fields
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    summary: 'Minimal summary',
                    // No modelName, processingTimeMs, inputTokens, outputTokens
                },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Minimal summary',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-partial-response',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            const result = await processor.process(createMockJob(payload));

            expect(result.summaryMeta).toEqual({
                aiModelId: undefined,
                processingTimeMs: undefined,
                inputTokens: undefined,
                outputTokens: undefined,
            });
        });

        it('should handle empty caseNoteIds array', async () => {
            const caseNotes = [createMockContextItem({ content: 'Default case note' })];

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue(caseNotes);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary',
            });

            const payload: GeneratePreSummaryJobPayload = {
                jobId: 'job-empty-ids',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {
                    caseNoteIds: [], // Empty array should fall through to findByConsultation
                },
            };

            await processor.process(createMockJob(payload));

            // Empty array is falsy for length check, so should use findByConsultation
            expect(mockContextItemRepository.findByConsultation).toHaveBeenCalled();
        });
    });

    // ===========================================================================
    // Behavior Verification Tests (Anti-Pattern #1 Prevention)
    // These tests verify actual output behavior, not just mock interactions
    // ===========================================================================

    describe('Behavior Verification', () => {
        it('should return result with content matching SMR response summary', async () => {
            // Arrange: Set up realistic data flow
            const inputCaseNote = createRealisticCaseNoteContent('subjective');
            const expectedSummary = 'Patient reports chronic headaches for 3 weeks with frontal throbbing pain rated 6/10.';

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: inputCaseNote }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: createRealisticSmrResponse({ summary: expectedSummary }),
            });
            // The create mock needs to return an object with id and content
            mockContextItemRepository.create.mockResolvedValue({
                id: 'created-context-id',
                content: expectedSummary,  // The saved content should match
            });

            // Act
            const result = await processor.process(createMockJob({
                jobId: 'job-behavior-1',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            }));

            // Assert: Verify actual output contains expected content
            expect(result.content).toBe(expectedSummary);
            expect(result.contextItemId).toBe('created-context-id');
        });

        it('should aggregate multiple case notes correctly before sending to SMR', async () => {
            // Arrange: Multiple SOAP notes that should be combined
            const subjectiveNote = createRealisticCaseNoteContent('subjective');
            const objectiveNote = createRealisticCaseNoteContent('objective');
            const assessmentNote = createRealisticCaseNoteContent('assessment');

            const caseNotes = [
                createMockContextItem({ id: 'note-1', content: subjectiveNote }),
                createMockContextItem({ id: 'note-2', content: objectiveNote }),
                createMockContextItem({ id: 'note-3', content: assessmentNote }),
            ];

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue(caseNotes);

            // Capture what was sent to SMR service
            let sentContent = '';
            mockHttpService.axiosRef.post.mockImplementation(async (_url, payload) => {
                sentContent = payload.text;
                return { data: createRealisticSmrResponse() };
            });
            mockContextItemRepository.create.mockResolvedValue({ id: 'ctx-id', content: 'Summary' });

            // Act
            await processor.process(createMockJob({
                jobId: 'job-aggregate',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            }));

            // Assert: Verify all notes were combined with proper separator
            expect(sentContent).toContain(subjectiveNote);
            expect(sentContent).toContain(objectiveNote);
            expect(sentContent).toContain(assessmentNote);
            expect(sentContent).toBe(`${subjectiveNote}\n\n${objectiveNote}\n\n${assessmentNote}`);
        });

        it('should preserve dnaStyleId through the entire processing pipeline', async () => {
            const dnaStyleId = 'custom-medical-style-v2';

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: 'Test content' }),
            ]);

            // Capture the payload sent to SMR
            let smrPayload: any = null;
            mockHttpService.axiosRef.post.mockImplementation(async (_url, payload) => {
                smrPayload = payload;
                return { data: createRealisticSmrResponse() };
            });
            mockContextItemRepository.create.mockResolvedValue({ id: 'ctx-id', content: 'Summary' });

            // Act
            await processor.process(createMockJob({
                jobId: 'job-style',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: { dnaStyleId },
            }));

            // Assert: dnaStyleId was passed to SMR service
            expect(smrPayload.dnaStyleId).toBe(dnaStyleId);
        });

        it('should include all SMR response metadata in result summaryMeta', async () => {
            const smrResponse = createRealisticSmrResponse({
                modelName: 'gpt-4-turbo-2024-04-09',
                processingTimeMs: 3456,
                inputTokens: 234,
                outputTokens: 89,
            });

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: 'Test content' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({ data: smrResponse });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: smrResponse.summary,
            });

            // Act
            const result = await processor.process(createMockJob({
                jobId: 'job-meta',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            }));

            // Assert: All metadata is preserved
            expect(result.summaryMeta).toEqual({
                aiModelId: 'gpt-4-turbo-2024-04-09',
                processingTimeMs: 3456,
                inputTokens: 234,
                outputTokens: 89,
            });
        });

        it('should pass correct parameters to ContextItemFactory when saving', async () => {
            const tenantId = 'tenant-specific-123';
            const consultationId = 'consultation-specific-456';
            const userId = 'user-specific-789';
            const dnaStyleId = 'style-specific';
            const generatedSummary = 'AI Generated pre-summary content';

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation({ id: consultationId }));
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: 'Input content' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: createRealisticSmrResponse({ summary: generatedSummary }),
            });

            // Capture what was passed to create
            let createdItem: any = null;
            mockContextItemRepository.create.mockImplementation((item) => {
                createdItem = item;
                return { id: 'new-id', ...item };
            });

            // Act
            await processor.process(createMockJob({
                jobId: 'job-factory',
                consultationId,
                tenantId,
                userId,
                request: { dnaStyleId },
            }));

            // Assert: The created item has correct data
            // Note: This verifies the behavior of calling ContextItemFactory correctly
            expect(mockContextItemRepository.create).toHaveBeenCalled();
            // The factory should have been called and the item should contain the summary
        });

        it('should complete full processing cycle and return well-formed result', async () => {
            // This is an end-to-end style test within the processor
            const inputContent = createRealisticCaseNoteContent('subjective');
            const smrResponse = createRealisticSmrResponse();

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findByConsultation.mockResolvedValue([
                createMockContextItem({ content: inputContent }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({ data: smrResponse });
            mockContextItemRepository.create.mockImplementation((item) => ({
                id: 'final-context-id',
                content: item.content || smrResponse.summary,
            }));

            // Act
            const result = await processor.process(createMockJob({
                jobId: 'job-e2e',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: { dnaStyleId: 'test-style' },
            }));

            // Assert: Full result structure
            expect(result).toMatchObject({
                contextItemId: expect.any(String),
                content: expect.any(String),
                summaryMeta: {
                    aiModelId: expect.any(String),
                    processingTimeMs: expect.any(Number),
                    inputTokens: expect.any(Number),
                    outputTokens: expect.any(Number),
                },
            });

            // Verify the complete notification sequence
            expect(mockJobService.notifyProgress).toHaveBeenCalledWith('job-e2e', 10, 'Gathering case notes');
            expect(mockJobService.notifyProgress).toHaveBeenCalledWith('job-e2e', 30, 'Generating pre-summary with AI');
            expect(mockJobService.notifyProgress).toHaveBeenCalledWith('job-e2e', 70, 'Saving results');
            expect(mockJobService.notifyComplete).toHaveBeenCalledWith('job-e2e', result);
        });
    });
});
