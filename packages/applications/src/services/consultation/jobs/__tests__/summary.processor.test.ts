/**
 * SummaryProcessor Unit Tests
 *
 * Tests for the SummaryProcessor that handles async summary generation jobs.
 * The processor gathers transcripts/context items and calls the SMR service.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { SummaryProcessor } from '../processors/summary.processor';
import { GenerateSummaryJobPayload, SummaryJobResult } from '../dto';

// Mock consultation job service
const createMockJobService = () => ({
    notifyProgress: vi.fn().mockResolvedValue(undefined),
    notifyComplete: vi.fn().mockResolvedValue(undefined),
    notifyFailed: vi.fn().mockResolvedValue(undefined),
});

// Mock repositories
const createMockContextItemRepository = () => ({
    findById: vi.fn(),
    findTranscripts: vi.fn(),
    findLatestPreSummary: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
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

// Mock EventEmitter2
const createMockEventEmitter = () => ({
    emit: vi.fn(),
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

// Mock ClsService. Real nestjs-cls.ClsService.run executes the
// callback inside a fresh AsyncLocalStorage scope; the mock just runs it
// inline so existing tests stay synchronous, while exposing the underlying
// `run`/`set`/`get` spies the new D.9 tests use to verify CLS rebinding.
const createMockClsService = () => {
    const store = new Map<string, unknown>();
    const mock = {
        run: vi.fn((...args: unknown[]) => {
            const callback = (args.length === 1 ? args[0] : args[1]) as () => unknown;
            return callback();
        }),
        runWith: vi.fn((seed: Record<string, unknown>, callback: () => unknown) => {
            for (const [k, v] of Object.entries(seed)) store.set(k, v);
            return callback();
        }),
        set: vi.fn((key: string, value: unknown) => { store.set(key, value); }),
        get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
        has: vi.fn((key: string) => store.has(key)),
        isActive: vi.fn(() => true),
    };
    return mock;
};

// Mock NamedEntityRepository (NER → prompt injection)
const createMockNamedEntityRepository = () => ({
    findByConsultation: vi.fn().mockResolvedValue([]),
});

// Mock ConfigResolver (doctor-preferred prompt id).
const createMockConfigResolver = () => ({
    resolvePreferredPromptTemplateId: vi.fn().mockResolvedValue(null),
    resolvePipelineToggles: vi.fn(),
});

// Helper to create mock job
const createMockJob = (data: GenerateSummaryJobPayload): Job<GenerateSummaryJobPayload> =>
    ({
        data,
        id: data.jobId,
        name: 'generate',
        timestamp: Date.now(),
    }) as unknown as Job<GenerateSummaryJobPayload>;

// Helper to create mock consultation
const createMockConsultation = (overrides: Partial<any> = {}) => ({
    id: overrides.id ?? 'consultation-123',
    tenantId: overrides.tenantId ?? 'tenant-1',
    patientId: overrides.patientId ?? 'patient-1',
    doctorId: overrides.doctorId ?? 'doctor-1',
    ...overrides,
});

// Helper to create mock context item
const createMockContextItem = (overrides: Partial<any> = {}) => ({
    id: overrides.id ?? 'ctx-item-123',
    consultationId: overrides.consultationId ?? 'consultation-123',
    type: overrides.type ?? 'TRANSCRIPT',
    content: overrides.content ?? 'Doctor: How are you feeling today?\nPatient: I have a headache.',
    tenantId: overrides.tenantId ?? 'tenant-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
});

describe('SummaryProcessor', () => {
    let processor: SummaryProcessor;
    let mockJobService: ReturnType<typeof createMockJobService>;
    let mockContextItemRepository: ReturnType<typeof createMockContextItemRepository>;
    let mockConsultationRepository: ReturnType<typeof createMockConsultationRepository>;
    let mockHttpService: ReturnType<typeof createMockHttpService>;
    let mockConfigService: ReturnType<typeof createMockConfigService>;
    let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
    let mockPromptResolutionService: ReturnType<typeof createMockPromptResolutionService>;
    let mockPromptAssemblyService: ReturnType<typeof createMockPromptAssemblyService>;
    let mockJobMetrics: ReturnType<typeof createMockJobMetrics>;
    let mockClsService: ReturnType<typeof createMockClsService>;
    let mockHarnessPolicyService: { resolveSmrSelection: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        vi.clearAllMocks();

        mockJobService = createMockJobService();
        mockContextItemRepository = createMockContextItemRepository();
        mockConsultationRepository = createMockConsultationRepository();
        mockHttpService = createMockHttpService();
        mockConfigService = createMockConfigService();
        mockEventEmitter = createMockEventEmitter();
        mockPromptResolutionService = createMockPromptResolutionService();
        mockPromptAssemblyService = createMockPromptAssemblyService();
        mockJobMetrics = createMockJobMetrics();
        mockClsService = createMockClsService();
        mockHarnessPolicyService = {
            resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'resolved-medgemma' }),
        };

        processor = new SummaryProcessor(
            mockJobService as any,
            mockContextItemRepository as any,
            mockConsultationRepository as any,
            mockHttpService as any,
            mockConfigService as any,
            mockEventEmitter as any,
            mockPromptResolutionService as any,
            mockPromptAssemblyService as any,
            mockJobMetrics as any,
            mockClsService as any,
            undefined, // secretsService (@Optional)
            undefined, // namedEntityRepository (@Optional)
            mockHarnessPolicyService as any, // HarnessPolicyService resolver
        );
    });

    // ── (§2.5): the BullMQ path threads the preferred prompt id ──
    describe('preferred-prompt threading (Phase 5)', () => {
        let mockConfigResolver: ReturnType<typeof createMockConfigResolver>;
        let processorWithResolver: SummaryProcessor;

        beforeEach(() => {
            mockConfigResolver = createMockConfigResolver();
            processorWithResolver = new SummaryProcessor(
                mockJobService as any,
                mockContextItemRepository as any,
                mockConsultationRepository as any,
                mockHttpService as any,
                mockConfigService as any,
                mockEventEmitter as any,
                mockPromptResolutionService as any,
                mockPromptAssemblyService as any,
                mockJobMetrics as any,
                mockClsService as any,
                undefined, // secretsService
                undefined, // namedEntityRepository
                mockHarnessPolicyService as any,
                mockConfigResolver as any, // ConfigResolver
            );

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation({ doctorId: 'dr-smith-001' }));
            mockContextItemRepository.findTranscripts.mockResolvedValue([createMockContextItem({ content: 'T' })]);
            mockHttpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });
            mockContextItemRepository.create.mockResolvedValue({ id: 'sid', content: 'S' });
        });

        it('threads the doctor preferred prompt id into resolve + assemble (no explicit template)', async () => {
            mockConfigResolver.resolvePreferredPromptTemplateId.mockResolvedValue('tpl-preferred');

            await processorWithResolver.process(createMockJob({
                jobId: 'job-pref',
                consultationId: 'c-1',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            } as GenerateSummaryJobPayload));

            expect(mockConfigResolver.resolvePreferredPromptTemplateId).toHaveBeenCalledWith('dr-smith-001');
            expect(mockPromptResolutionService.resolve).toHaveBeenCalledWith(
                expect.objectContaining({ preferredPromptTemplateId: 'tpl-preferred' }),
            );
            expect(mockPromptAssemblyService.assemble).toHaveBeenCalledWith(
                expect.objectContaining({ preferredPromptTemplateId: 'tpl-preferred' }),
            );
        });

        it('passes the preferred id to assemble even when an explicit template is set', async () => {
            mockConfigResolver.resolvePreferredPromptTemplateId.mockResolvedValue('tpl-preferred');

            await processorWithResolver.process(createMockJob({
                jobId: 'job-pref-2',
                consultationId: 'c-1',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: { template: 'SOAP' },
            } as GenerateSummaryJobPayload));

            // resolve() is skipped when a template is explicit, but assemble() still threads the id.
            expect(mockPromptAssemblyService.assemble).toHaveBeenCalledWith(
                expect.objectContaining({ preferredPromptTemplateId: 'tpl-preferred' }),
            );
        });
    });

    // ── the SMR call carries the cascade-resolved model ──
    describe('SMR selection', () => {
        it('posts the cascade-resolved provider+model when the request omits a model', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([createMockContextItem({ content: 'T' })]);
            mockHttpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });
            mockContextItemRepository.create.mockResolvedValue({ id: 'sid', content: 'S' });

            await processor.process(createMockJob({
                jobId: 'job-1',
                consultationId: 'c-1',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            } as GenerateSummaryJobPayload));

            expect(mockHarnessPolicyService.resolveSmrSelection).toHaveBeenCalled();
            const smrCall = mockHttpService.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/api/v1/generate'))!;
            const body = smrCall[1] as { provider?: string; model?: string };
            expect(body.provider).toBe('lm-studio');
            expect(body.model).toBe('resolved-medgemma');
        });
    });

    // ===========================================================================
    // Successful Processing Tests
    // ===========================================================================

    describe('Successful Job Processing', () => {
        it('should process summary job with specific contextItemIds', async () => {
            const ctx1 = createMockContextItem({ id: 'ctx-1', content: 'Transcript part 1' });
            const ctx2 = createMockContextItem({ id: 'ctx-2', content: 'Transcript part 2' });

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findById
                .mockResolvedValueOnce(ctx1)
                .mockResolvedValueOnce(ctx2);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    summary: 'Generated clinical summary',
                    modelName: 'gpt-4',
                    processingTimeMs: 4500,
                    inputTokens: 350,
                    outputTokens: 120,
                },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'new-summary-id',
                content: 'Generated clinical summary',
            });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {
                    contextItemIds: ['ctx-1', 'ctx-2'],
                    dnaStyleId: 'clinical-style',
                    template: 'soap-note',
                    includeNER: true,
                },
            };

            const result = await processor.process(createMockJob(payload));

            expect(result).toEqual({
                contextItemId: 'new-summary-id',
                content: 'Generated clinical summary',
                summaryMeta: {
                    aiModelId: 'gpt-4',
                    processingTimeMs: 4500,
                    inputTokens: 350,
                    outputTokens: 120,
                },
            });

            expect(mockJobService.notifyProgress).toHaveBeenCalledTimes(3);
            expect(mockJobService.notifyComplete).toHaveBeenCalledWith('job-123', result);
        });

        it('should process summary job using all transcripts when no contextItemIds provided', async () => {
            const transcripts = [
                createMockContextItem({ id: 'trans-1', content: 'Transcript 1' }),
                createMockContextItem({ id: 'trans-2', content: 'Transcript 2' }),
            ];

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue(transcripts);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    summary: 'Summary from all transcripts',
                    modelName: 'claude-3',
                    processingTimeMs: 5000,
                },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'new-summary-id',
                content: 'Summary from all transcripts',
            });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-456',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {}, // No contextItemIds
            };

            await processor.process(createMockJob(payload));

            expect(mockContextItemRepository.findTranscripts).toHaveBeenCalledWith('consultation-123');
        });

        it('should send correct payload to SMR service with all options', async () => {
            const transcript = createMockContextItem({ content: 'Full consultation transcript' });

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([transcript]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary',
            });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-789',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {
                    dnaStyleId: 'formal-style',
                    template: 'discharge-summary',
                    includeNER: true,
                    options: { maxTokens: 2000, temperature: 0.5 },
                },
            };

            await processor.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                'http://localhost:8862/api/v1/generate',
                expect.objectContaining({
                    prompt: 'Full consultation transcript',
                    temperature: 0.5,
                    max_tokens: 2000,
                    context: expect.objectContaining({
                        dnaStyleId: 'formal-style',
                        template: 'discharge-summary',
                        includeNER: true,
                        maxTokens: 2000,
                        temperature: 0.5,
                        summaryType: 'summary',
                    }),
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
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Test content' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary',
            });

            const payload: GenerateSummaryJobPayload = {
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
                'Gathering context',
            );
            expect(mockJobService.notifyProgress).toHaveBeenNthCalledWith(
                2,
                'job-progress',
                30,
                'Generating summary with AI',
            );
            expect(mockJobService.notifyProgress).toHaveBeenNthCalledWith(
                3,
                'job-progress',
                70,
                'Saving results',
            );
        });

        it('should join multiple context items with double newlines', async () => {
            const contexts = [
                createMockContextItem({ content: 'First part' }),
                createMockContextItem({ content: 'Second part' }),
                createMockContextItem({ content: 'Third part' }),
            ];

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue(contexts);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Combined summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Combined summary',
            });

            const payload: GenerateSummaryJobPayload = {
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
                    prompt: 'First part\n\nSecond part\n\nThird part',
                }),
                expect.any(Object),
            );
        });

        it('should handle includeNER flag as false', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Transcript' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary without NER', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary without NER',
            });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-no-ner',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {
                    includeNER: false,
                },
            };

            await processor.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    context: expect.objectContaining({
                        includeNER: false,
                    }),
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

            const payload: GenerateSummaryJobPayload = {
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

        it('should fail when no transcripts available', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([]);

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-no-transcripts',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'No content available for summary generation',
            );

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'job-no-transcripts',
                'No content available for summary generation',
            );
        });

        it('should fail when all context items have empty content', async () => {
            const emptyContexts = [
                createMockContextItem({ content: '' }),
                createMockContextItem({ content: '   ' }),
                createMockContextItem({ content: '\t\n' }),
            ];

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue(emptyContexts);

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-empty',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'No content available for summary generation',
            );
        });

        it('should fail when specific contextItemIds not found', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findById.mockResolvedValue(null);

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-missing-ids',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {
                    contextItemIds: ['missing-1', 'missing-2'],
                },
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'No content available for summary generation',
            );
        });

        it('should fail when SMR service call fails', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Valid content' }),
            ]);
            mockHttpService.axiosRef.post.mockRejectedValue(new Error('Connection refused'));

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-smr-error',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Failed to generate summary from AI service',
            );

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'job-smr-error',
                'Failed to generate summary from AI service',
            );
        });

        it('should fail when SMR service returns 500 error', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Valid content' }),
            ]);
            mockHttpService.axiosRef.post.mockRejectedValue({
                response: { status: 500, data: { error: 'Internal error' } },
                message: 'Request failed with status 500',
            });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-smr-500',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Failed to generate summary from AI service',
            );
        });

        it('should fail when SMR service times out', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Valid content' }),
            ]);
            mockHttpService.axiosRef.post.mockRejectedValue({
                code: 'ETIMEDOUT',
                message: 'timeout of 120000ms exceeded',
            });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-timeout',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Failed to generate summary from AI service',
            );
        });

        it('should handle repository create failure', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Valid content' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Generated summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockRejectedValue(
                new Error('Database connection lost'),
            );

            const payload: GenerateSummaryJobPayload = {
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
        it('should filter out null context items when using specific IDs', async () => {
            const validCtx = createMockContextItem({
                id: 'ctx-2',
                content: 'Valid transcript content',
            });

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findById
                .mockResolvedValueOnce(null) // ctx-1 not found
                .mockResolvedValueOnce(validCtx) // ctx-2 found
                .mockResolvedValueOnce(null); // ctx-3 not found
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary from valid context', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary from valid context',
            });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-partial',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {
                    contextItemIds: ['ctx-1', 'ctx-2', 'ctx-3'],
                },
            };

            await processor.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    prompt: 'Valid transcript content',
                }),
                expect.any(Object),
            );
        });

        it('should use default SMR URL when not configured', async () => {
            const configServiceWithoutUrl = {
                get: vi.fn().mockReturnValue(undefined),
            };

            const processorWithDefaultUrl = new SummaryProcessor(
                mockJobService as any,
                mockContextItemRepository as any,
                mockConsultationRepository as any,
                mockHttpService as any,
                configServiceWithoutUrl as any,
                mockEventEmitter as any,
                mockPromptResolutionService as any,
                mockPromptAssemblyService as any,
                mockJobMetrics as any,
                mockClsService as any,
            );

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Content' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary',
            });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-default-url',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            };

            await processorWithDefaultUrl.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                'http://localhost:8862/api/v1/generate',
                expect.any(Object),
                expect.any(Object),
            );
        });

        it('should handle very long transcript content', async () => {
            const longContent = 'Transcript: ' + 'x'.repeat(100000);
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: longContent }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary of long transcript', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary of long transcript',
            });

            const payload: GenerateSummaryJobPayload = {
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
                    prompt: longContent,
                }),
                expect.any(Object),
            );
        });

        it('should handle special characters and unicode in transcript', async () => {
            const specialContent = `
Doctor: Good morning, Mr. García. ¿Cómo está?
Patient: Tengo dolor de cabeza 頭痛がします
Notes: Temperature < 38°C, SpO₂ > 95%
Assessment: "Alert" & oriented × 3
            `.trim();

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: specialContent }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Multilingual summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Multilingual summary',
            });

            const payload: GenerateSummaryJobPayload = {
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
                    prompt: specialContent,
                }),
                expect.any(Object),
            );
        });

        it('should handle SMR service returning partial response', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Test content' }),
            ]);
            // Response without optional fields
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    summary: 'Minimal summary response',
                    // No modelName, processingTimeMs, etc.
                },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Minimal summary response',
            });

            const payload: GenerateSummaryJobPayload = {
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

        it('should handle empty contextItemIds array', async () => {
            const transcripts = [createMockContextItem({ content: 'Default transcript' })];

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue(transcripts);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Summary',
            });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-empty-ids',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {
                    contextItemIds: [],
                },
            };

            await processor.process(createMockJob(payload));

            // Empty array should fall through to findTranscripts
            expect(mockContextItemRepository.findTranscripts).toHaveBeenCalled();
        });

        it('should handle multiple templates', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Transcript' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'SOAP formatted summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'SOAP formatted summary',
            });

            const templates = ['soap-note', 'discharge-summary', 'referral-letter', 'progress-note'];

            for (const template of templates) {
                vi.clearAllMocks();

                const payload: GenerateSummaryJobPayload = {
                    jobId: `job-${template}`,
                    consultationId: 'consultation-123',
                    tenantId: 'tenant-1',
                    userId: 'user-1',
                    request: { template },
                };

                await processor.process(createMockJob(payload));

                expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                    expect.any(String),
                    expect.objectContaining({
                        context: expect.objectContaining({ template }),
                    }),
                    expect.any(Object),
                );
            }
        });

        it('should handle consultation with mixed content types', async () => {
            // Even though finding transcripts, the IDs could be mixed
            const mixedContexts = [
                createMockContextItem({ id: 'ctx-1', type: 'TRANSCRIPT', content: 'Transcript 1' }),
                createMockContextItem({ id: 'ctx-2', type: 'CASE_NOTE', content: 'Case note' }),
                createMockContextItem({ id: 'ctx-3', type: 'TRANSCRIPT', content: 'Transcript 2' }),
            ];

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findById
                .mockResolvedValueOnce(mixedContexts[0])
                .mockResolvedValueOnce(mixedContexts[1])
                .mockResolvedValueOnce(mixedContexts[2]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Mixed content summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-id',
                content: 'Mixed content summary',
            });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-mixed',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {
                    contextItemIds: ['ctx-1', 'ctx-2', 'ctx-3'],
                },
            };

            await processor.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    prompt: 'Transcript 1\n\nCase note\n\nTranscript 2',
                }),
                expect.any(Object),
            );
        });
    });

    // ===========================================================================
    // SummaryGenerated Pipeline Event Emission
    // ===========================================================================

    describe('SummaryGenerated pipeline event', () => {
        const setupSuccessfulJob = () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Transcript content' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Generated summary', modelName: 'gpt-4', processingTimeMs: 3000 },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'summary-ctx-001',
                content: 'Generated summary',
            });
        };

        it('should emit SummaryGenerated event after successful processing', async () => {
            setupSuccessfulJob();

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                request: { dnaStyleId: 'style-A', template: 'SOAP' },
            };

            await processor.process(createMockJob(payload));

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'consultation.summary.generated',
                expect.objectContaining({
                    consultationId: 'consultation-123',
                    tenantId: 'tenant-1',
                    userId: 'doctor-1',
                    contextItemId: 'summary-ctx-001',
                    jobId: 'job-123',
                    dnaStyleId: 'style-A',
                    template: 'SOAP',
                }),
            );
        });

        it('should set isAutoGenerated=true when options.autoGenerated is true', async () => {
            setupSuccessfulJob();

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                request: {
                    options: { autoGenerated: true, correlationId: 'corr-abc' },
                },
            };

            await processor.process(createMockJob(payload));

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'consultation.summary.generated',
                expect.objectContaining({
                    isAutoGenerated: true,
                    correlationId: 'corr-abc',
                }),
            );
        });

        it('should set isAutoGenerated=false when options.autoGenerated is absent', async () => {
            setupSuccessfulJob();

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                request: {},
            };

            await processor.process(createMockJob(payload));

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'consultation.summary.generated',
                expect.objectContaining({
                    isAutoGenerated: false,
                }),
            );
        });

        it('should include summaryMeta in event payload', async () => {
            setupSuccessfulJob();

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                request: {},
            };

            await processor.process(createMockJob(payload));

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'consultation.summary.generated',
                expect.objectContaining({
                    summaryMeta: expect.objectContaining({
                        aiModelId: 'gpt-4',
                        processingTimeMs: 3000,
                    }),
                }),
            );
        });

        it('should NOT emit event when processing fails', async () => {
            mockConsultationRepository.findById.mockResolvedValue(null);

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow();

            // eventEmitter.emit should NOT have been called with the pipeline event
            const pipelineCalls = mockEventEmitter.emit.mock.calls.filter(
                (c: any[]) => c[0] === 'consultation.summary.generated',
            );
            expect(pipelineCalls).toHaveLength(0);
        });

        it('should include ISO timestamp in event payload', async () => {
            setupSuccessfulJob();

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                request: {},
            };

            await processor.process(createMockJob(payload));

            const pipelineCall = mockEventEmitter.emit.mock.calls.find(
                (c: any[]) => c[0] === 'consultation.summary.generated',
            );
            expect(pipelineCall).toBeDefined();
            const ts = pipelineCall![1].timestamp;
            expect(ts).toBeDefined();
            expect(new Date(ts).toISOString()).toBe(ts);
        });
    });

    // ==========================================================================='
    // Prompt Resolution Integration
    // ==========================================================================='

    describe('Prompt resolution fallback', () => {
        const setupSuccessfulJob = () => {
            mockConsultationRepository.findById.mockResolvedValue(
                createMockConsultation({
                    doctorId: 'dr-smith-001',
                    departmentId: 'dept-card-001',
                    parentConsultationId: null,
                }),
            );
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Patient transcript content' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Generated summary', modelName: 'gpt-4', processingTimeMs: 3000 },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'summary-ctx-001',
                content: 'Generated summary',
            });
        };

        it('should call PromptResolutionService when template is missing', async () => {
            setupSuccessfulJob();

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                request: {}, // template missing
            };

            await processor.process(createMockJob(payload));

            expect(mockPromptResolutionService.resolve).toHaveBeenCalledWith(
                expect.objectContaining({
                    departmentId: 'dept-card-001',
                }),
            );
        });

        it('should call PromptResolutionService when template is missing (dnaStyleId provided)', async () => {
            setupSuccessfulJob();

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                request: { dnaStyleId: 'style-explicit' }, // template missing
            };

            await processor.process(createMockJob(payload));

            expect(mockPromptResolutionService.resolve).toHaveBeenCalledWith(
                expect.objectContaining({
                    departmentId: 'dept-card-001',
                }),
            );
        });

        it('should NOT call PromptResolutionService when template is provided', async () => {
            setupSuccessfulJob();

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                request: { dnaStyleId: 'style-explicit', template: 'SOAP' },
            };

            await processor.process(createMockJob(payload));

            expect(mockPromptResolutionService.resolve).not.toHaveBeenCalled();
        });

        it('should use resolved template in SMR service call when request has none', async () => {
            setupSuccessfulJob();
            mockPromptResolutionService.resolve.mockResolvedValue({
                template: 'Cardiology-Report',
                promptId: 'prompt_card_new',
                contextVariables: {},
                resolvedFrom: 'department',
                resolutionTrace: { usedDefaults: [] },
            });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                request: {}, // both missing
            };

            await processor.process(createMockJob(payload));

            // Verify SMR was called with resolved template (dnaStyleId not resolved, so undefined)
            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                expect.stringContaining('/api/v1/generate'),
                expect.objectContaining({
                    context: expect.objectContaining({
                        template: 'Cardiology-Report',
                    }),
                }),
                expect.any(Object),
            );
        });

        it('should pass departmentId when consultation has parentConsultationId', async () => {
            mockConsultationRepository.findById.mockResolvedValue(
                createMockConsultation({
                    doctorId: 'dr-jones-001',
                    departmentId: 'dept-hema-001',
                    parentConsultationId: 'consultation-parent-001',
                }),
            );
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Follow-up transcript' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Follow-up summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'summary-ctx-002',
                content: 'Follow-up summary',
            });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-456',
                consultationId: 'consultation-456',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                request: {}, // no explicit dnaStyleId/template
            };

            await processor.process(createMockJob(payload));

            expect(mockPromptResolutionService.resolve).toHaveBeenCalledWith(
                expect.objectContaining({
                    departmentId: 'dept-hema-001',
                }),
            );
        });
    });

    // ===========================================================================
    // CLS rebind + tenant assert + fail-closed guard
    //
    // Workers run OUTSIDE the API edge ClsModule middleware that the
    // tenantScope extension reads from. Without these guards the
    // extension hits its "no CLS = super-admin pass-through" branch and
    // every Prisma op silently bypasses tenant scoping.
    // ===========================================================================

    describe('CLS rebind + tenant assert', () => {
        const setupSuccessfulJob = (consultationOverrides: Record<string, unknown> = {}) => {
            mockConsultationRepository.findById.mockResolvedValue(
                createMockConsultation(consultationOverrides),
            );
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'transcript content' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Generated summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'summary-ctx-001',
                content: 'Generated summary',
            });
        };

        it('wraps process() in cls.run with tenantId + user set before any work runs', async () => {
            setupSuccessfulJob({ tenantId: 'tenant-A' });
            const setOrder: Array<[string, unknown]> = [];
            mockClsService.set.mockImplementation((key: string, value: unknown) => {
                setOrder.push([key, value]);
            });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-cls-1',
                consultationId: 'consultation-123',
                tenantId: 'tenant-A',
                userId: 'user-A',
                request: {},
            };

            await processor.process(createMockJob(payload));

            expect(mockClsService.run).toHaveBeenCalledTimes(1);
            const keys = setOrder.map(([k]) => k);
            expect(keys).toContain('tenantId');
            expect(keys).toContain('user');
            const tenantEntry = setOrder.find(([k]) => k === 'tenantId');
            expect(tenantEntry?.[1]).toBe('tenant-A');
            const userEntry = setOrder.find(([k]) => k === 'user');
            expect(userEntry?.[1]).toMatchObject({ id: 'user-A', tenantId: 'tenant-A' });
        });

        it('throws fail-closed when job.data.tenantId is missing', async () => {
            const payload = {
                jobId: 'job-no-tenant',
                consultationId: 'consultation-123',
                userId: 'user-1',
                request: {},
                // tenantId intentionally omitted (legacy / poisoned job)
            } as unknown as GenerateSummaryJobPayload;

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                /tenantId/i,
            );
            expect(mockConsultationRepository.findById).not.toHaveBeenCalled();
        });

        it('throws when loaded consultation.tenantId differs from job.data.tenantId', async () => {
            setupSuccessfulJob({ tenantId: 'tenant-OTHER' });

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-mismatch',
                consultationId: 'consultation-123',
                tenantId: 'tenant-A',
                userId: 'user-A',
                request: {},
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow();
            // Make sure we never reached the write side.
            expect(mockContextItemRepository.create).not.toHaveBeenCalled();
            expect(mockJobService.notifyFailed).toHaveBeenCalled();
        });
    });

    // ===========================================================================
    // NER → prompt injection
    //
    // The processor must query the consultation's NER entities and forward them
    // to PromptAssemblyService so they actually reach the LLM.
    // ===========================================================================

    describe('NER → prompt injection (Phase 1)', () => {
        let mockNamedEntityRepository: ReturnType<typeof createMockNamedEntityRepository>;
        let nerProcessor: SummaryProcessor;

        const setupSuccessfulJob = () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Patient on amoxicillin.' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({ id: 'ctx-id', content: 'Summary' });
        };

        beforeEach(() => {
            mockNamedEntityRepository = createMockNamedEntityRepository();
            nerProcessor = new SummaryProcessor(
                mockJobService as any,
                mockContextItemRepository as any,
                mockConsultationRepository as any,
                mockHttpService as any,
                mockConfigService as any,
                mockEventEmitter as any,
                mockPromptResolutionService as any,
                mockPromptAssemblyService as any,
                mockJobMetrics as any,
                mockClsService as any,
                undefined, // secretsService (optional)
                mockNamedEntityRepository as any, // namedEntityRepository (optional)
            );
        });

        it('queries NER entities and forwards them (mapped) to assemble() when includeNER is true', async () => {
            setupSuccessfulJob();
            mockNamedEntityRepository.findByConsultation.mockResolvedValue([
                {
                    text: 'amoxicillin',
                    className: 'MEDICATION',
                    normalizedText: null,
                    umlsCui: null,
                    snomedCode: null,
                    rxnormCode: '723',
                    icdCode: null,
                    loincCode: null,
                    startOffset: 11,
                    endOffset: 22,
                    transcriptStartOffset: null,
                    transcriptEndOffset: null,
                },
            ]);

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-ner',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: { includeNER: true },
            };

            await nerProcessor.process(createMockJob(payload));

            expect(mockNamedEntityRepository.findByConsultation).toHaveBeenCalledWith('consultation-123');
            expect(mockPromptAssemblyService.assemble).toHaveBeenCalledWith(
                expect.objectContaining({
                    nerEntities: expect.arrayContaining([
                        expect.objectContaining({
                            text: 'amoxicillin',
                            type: 'MEDICATION',
                            rxnormCode: '723',
                            startOffset: 11,
                            endOffset: 22,
                        }),
                    ]),
                }),
            );
        });

        it('prefers transcript-span offsets over raw offsets when mapping', async () => {
            setupSuccessfulJob();
            mockNamedEntityRepository.findByConsultation.mockResolvedValue([
                {
                    text: 'pneumonia',
                    className: 'CONDITION',
                    normalizedText: 'pneumonia',
                    icdCode: 'J18.9',
                    startOffset: 1,
                    endOffset: 2,
                    transcriptStartOffset: 40,
                    transcriptEndOffset: 49,
                },
            ]);

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-ner-span',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: { includeNER: true },
            };

            await nerProcessor.process(createMockJob(payload));

            expect(mockPromptAssemblyService.assemble).toHaveBeenCalledWith(
                expect.objectContaining({
                    nerEntities: expect.arrayContaining([
                        expect.objectContaining({
                            text: 'pneumonia',
                            type: 'CONDITION',
                            icdCode: 'J18.9',
                            startOffset: 40,
                            endOffset: 49,
                        }),
                    ]),
                }),
            );
        });

        it('does NOT query NER entities when includeNER is false', async () => {
            setupSuccessfulJob();

            const payload: GenerateSummaryJobPayload = {
                jobId: 'job-no-ner',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: { includeNER: false },
            };

            await nerProcessor.process(createMockJob(payload));

            expect(mockNamedEntityRepository.findByConsultation).not.toHaveBeenCalled();
        });
    });

    // ── F-031 remainder: the raw-summary ContextItem must be encrypted
    // before persist, or its clinical text silently vanishes at rest (the
    // plaintext `content` column was dropped; only `encryptedContent` persists).
    describe('transcript content encryption-at-rest (F-031)', () => {
        const secretsStub = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') };

        it('encrypts the generated summary content before persisting', async () => {
            const processorWithSecrets = new SummaryProcessor(
                mockJobService as any,
                mockContextItemRepository as any,
                mockConsultationRepository as any,
                mockHttpService as any,
                mockConfigService as any,
                mockEventEmitter as any,
                mockPromptResolutionService as any,
                mockPromptAssemblyService as any,
                mockJobMetrics as any,
                mockClsService as any,
                secretsStub as any,
            );

            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Transcript content' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Generated clinical summary', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'enc-summary-id',
                content: 'Generated clinical summary',
            });

            await processorWithSecrets.process(createMockJob({
                jobId: 'job-enc-1',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            }));

            expect(mockContextItemRepository.encryptContentIntoEntity).toHaveBeenCalledTimes(1);
            const [entityArg, secretsArg] = mockContextItemRepository.encryptContentIntoEntity.mock.calls[0];
            expect(entityArg.content).toBe('Generated clinical summary');
            expect(secretsArg).toBe(secretsStub);
            const encOrder = mockContextItemRepository.encryptContentIntoEntity.mock.invocationCallOrder[0];
            const createOrder = mockContextItemRepository.create.mock.invocationCallOrder[0];
            expect(encOrder).toBeLessThan(createOrder);
            expect(mockContextItemRepository.create.mock.calls[0][0]).toBe(entityArg);
        });

        it('still persists (without ciphertext) when no SecretsService is wired', async () => {
            mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                createMockContextItem({ content: 'Transcript content' }),
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'No cipher wired', modelName: 'gpt-4' },
            });
            mockContextItemRepository.create.mockResolvedValue({ id: 'no-sec-id', content: 'No cipher wired' });

            await processor.process(createMockJob({
                jobId: 'job-no-sec',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                request: {},
            }));

            expect(mockContextItemRepository.encryptContentIntoEntity).not.toHaveBeenCalled();
        });
    });
});
