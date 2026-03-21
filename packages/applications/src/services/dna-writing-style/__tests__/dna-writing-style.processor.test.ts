/**
 * DnaWritingStyleProcessor Unit Tests
 *
 * Tests the BullMQ processor that calls SMR V2 to generate DNA reports.
 * Mocks at boundaries: HTTP service (SMR V2), repositories, job service.
 * Verifies actual processor behavior: text gathering, SMR call, storage, error handling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DnaWritingStyleProcessor } from '../dna-writing-style.processor';

// ─── Mock Factories ─────────────────────────────────────────────────

const createMockJobService = () => ({
    notifyProgress: vi.fn(),
    notifyComplete: vi.fn(),
    notifyFailed: vi.fn(),
});

const createMockContextItemRepository = () => ({
    findAll: vi.fn(),
});

const createMockDnaReportRepository = () => ({
    findLatestForDoctor: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
});

const createMockDnaVersionRepository = () => ({
    create: vi.fn(),
});

const createMockDnaUsageRecordRepository = () => ({
    create: vi.fn(),
});

const createMockPromptUsageRecordRepository = () => ({
    create: vi.fn(),
});

const createMockPromptManagementService = () => ({
    listPromptTemplates: vi.fn(),
});

const createMockHttpService = () => ({
    axiosRef: {
        post: vi.fn(),
    },
});

const createMockConfigService = () => ({
    get: vi.fn().mockReturnValue('http://localhost:8862'),
});

const createMockClsService = () => ({
    get: vi.fn(),
    set: vi.fn(),
    run: vi.fn(<T>(fn: () => T): T => fn()),
});

const createMockJobMetrics = () => ({
    recordJobStart: vi.fn().mockReturnValue(vi.fn().mockReturnValue(5.0)),
    recordJobComplete: vi.fn(),
    recordJobFailed: vi.fn(),
    recordWaitingDuration: vi.fn(),
    recordSmrCallDuration: vi.fn(),
});

const createMockAppSettingsService = (overrides: Record<string, unknown> = {}) => {
    const settings: Record<string, unknown> = {
        'dna-regen.max-samples': 50,
        'dna-regen.max-context-chars': 100000,
        ...overrides,
    };
    return {
        getValueWithDefault: vi.fn(<T>(key: string, defaultValue: T): T => {
            return key in settings ? (settings[key] as T) : defaultValue;
        }),
    };
};

// Mock domain factories
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    const DnaUsageRecordFactory = {
        CreateDnaUsageRecord: vi.fn((data: Record<string, unknown>) => ({
            ...data,
            id: 'new-usage-id',
            createdAt: new Date('2026-02-18T10:00:00Z'),
        })),
    };
    return {
        ...actual,
        DnaWritingStyleReportFactory: {
            CreateDnaWritingStyleReport: vi.fn((data: Record<string, unknown>) => ({
                ...data,
                id: 'new-report-id',
                isLatest: true,
                currentVersionNumber: 1,
                createdAt: new Date('2026-02-18T10:00:00Z'),
                updatedAt: new Date('2026-02-18T10:00:00Z'),
            })),
        },
        DnaWritingStyleVersionFactory: {
            CreateDnaWritingStyleVersion: vi.fn((data: Record<string, unknown>) => ({
                ...data,
                id: 'new-version-id',
                createdAt: new Date('2026-02-18T10:00:00Z'),
            })),
        },
        DnaUsageRecordFactory,
        PromptUsageRecordFactory: {
            CreatePromptUsageRecord: vi.fn((data: Record<string, unknown>) => ({
                ...data,
                id: 'new-prompt-usage-id',
                createdAt: new Date('2026-02-18T10:00:00Z'),
            })),
        },
    };
});

// ─── Job Helper ─────────────────────────────────────────────────────
// Complete mock matching BullMQ Job<GenerateDnaReportJobPayload>

const createMockJob = (overrides: Record<string, unknown> = {}) => ({
    data: {
        jobId: overrides.jobId ?? 'job-1',
        doctorId: overrides.doctorId ?? 'doctor-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        userId: overrides.userId ?? 'user-1',
        textSamples: overrides.textSamples ?? undefined,
    },
    id: overrides.jobId ?? 'job-1',
    progress: 0,
    timestamp: Date.now(),
});

// ─── SMR V2 Response Helper ─────────────────────────────────────────
// Complete mock matching real SMR V2 GenerateResponse (stream: false)

const createSmrV2Response = (content: string) => ({
    task_id: 'task-smr-1',
    status: 'completed' as const,
    content,
    provider: 'openai',
    model: 'gpt-4',
    usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
    latency_ms: 3200,
    finish_reason: 'stop' as const,
    created_at: '2026-02-18T10:00:00Z',
});

// Axios returns { data: response }
const createAxiosSmrResponse = (content: string) => ({
    data: createSmrV2Response(content),
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('DnaWritingStyleProcessor', () => {
    let processor: DnaWritingStyleProcessor;
    let mockJobService: ReturnType<typeof createMockJobService>;
    let mockAppSettings: ReturnType<typeof createMockAppSettingsService>;
    let mockContextItemRepo: ReturnType<typeof createMockContextItemRepository>;
    let mockDnaReportRepo: ReturnType<typeof createMockDnaReportRepository>;
    let mockDnaVersionRepo: ReturnType<typeof createMockDnaVersionRepository>;
    let mockDnaUsageRepo: ReturnType<typeof createMockDnaUsageRecordRepository>;
    let mockPromptUsageRepo: ReturnType<typeof createMockPromptUsageRecordRepository>;
    let mockPromptService: ReturnType<typeof createMockPromptManagementService>;
    let mockHttpService: ReturnType<typeof createMockHttpService>;
    let mockConfigService: ReturnType<typeof createMockConfigService>;
    let mockJobMetrics: ReturnType<typeof createMockJobMetrics>;
    let mockClsService: ReturnType<typeof createMockClsService>;

    beforeEach(() => {
        vi.clearAllMocks();

        mockJobService = createMockJobService();
        mockAppSettings = createMockAppSettingsService();
        mockContextItemRepo = createMockContextItemRepository();
        mockDnaReportRepo = createMockDnaReportRepository();
        mockDnaVersionRepo = createMockDnaVersionRepository();
        mockDnaUsageRepo = createMockDnaUsageRecordRepository();
        mockPromptUsageRepo = createMockPromptUsageRecordRepository();
        mockPromptService = createMockPromptManagementService();
        mockHttpService = createMockHttpService();
        mockConfigService = createMockConfigService();
        mockJobMetrics = createMockJobMetrics();
        mockClsService = createMockClsService();

        processor = new DnaWritingStyleProcessor(
            mockJobService as never,
            mockAppSettings as never,
            mockContextItemRepo as never,
            mockDnaReportRepo as never,
            mockDnaVersionRepo as never,
            mockDnaUsageRepo as never,
            mockPromptUsageRepo as never,
            mockPromptService as never,
            mockHttpService as never,
            mockConfigService as never,
            mockJobMetrics as never,
            mockClsService as never,
        );
    });

    // ─── Successful Processing ──────────────────────────────────

    describe('Successful Processing', () => {
        it('should process DNA report with provided text samples and return result', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze writing samples.', category: 'DNA_ANALYSIS' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse(
                    JSON.stringify({
                        reportData: { formality: 'high', sentenceLength: 'medium' },
                        styleText: 'Doctor writes in a formal, concise style.',
                    }),
                ),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'new-report-id',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({ id: 'new-version-id' });
            mockDnaUsageRepo.create.mockResolvedValue({ id: 'new-usage-id' });

            const result = await processor.process(
                createMockJob({ textSamples: ['Sample summary 1', 'Sample summary 2'] }) as never,
            );

            expect(result.reportId).toBe('new-report-id');
            expect(result.styleText).toBe('Doctor writes in a formal, concise style.');
            expect(result.reportData).toEqual({ formality: 'high', sentenceLength: 'medium' });
        });

        it('should call SMR V2 POST /api/v1/generate with stream: false', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze writing.', category: 'DNA_ANALYSIS' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Style"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                'http://localhost:8862/api/v1/generate',
                {
                    prompt: 'sample',
                    system_prompt: 'Analyze writing.',
                    stream: false,
                },
                {
                    timeout: 120000,
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Service-Token': '',
                    },
                },
            );
        });

        it('should succeed gathering from ContextItems when no textSamples provided', async () => {
            mockContextItemRepo.findAll.mockResolvedValue([
                { content: 'Doctor summary text 1', text: null },
                { content: null, text: 'Doctor summary text 2' },
            ]);
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"From context"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            const result = await processor.process(createMockJob({}) as never);

            expect(mockContextItemRepo.findAll).toHaveBeenCalled();
            const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
            expect(requestBody.prompt).toContain('Doctor summary text 1');
            expect(result.styleText).toBe('From context');
        });

        it('should handle SMR JSON response with reportData and styleText', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse(
                    JSON.stringify({
                        reportData: { formality: 'high', tone: 'formal' },
                        styleText: 'Formal medical writing style.',
                    }),
                ),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            const result = await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

            expect(result.reportData).toEqual({ formality: 'high', tone: 'formal' });
            expect(result.styleText).toBe('Formal medical writing style.');
        });

        it('should handle SMR plain text (non-JSON) — fallback to styleText only', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('This is plain text analysis, not JSON.'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            const result = await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

            expect(result.styleText).toBe('This is plain text analysis, not JSON.');
            expect(result.reportData).toEqual({});
        });

        it('should handle SMR JSON without styleText key — uses content as styleText', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' },
            ]);
            const jsonContent = JSON.stringify({
                reportData: { formality: 'medium' },
            });
            mockHttpService.axiosRef.post.mockResolvedValue(createAxiosSmrResponse(jsonContent));
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            const result = await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

            expect(result.reportData).toEqual({ formality: 'medium' });
            expect(result.styleText).toBe(jsonContent);
        });

        it('should still process when ContextItems exist but all have empty content', async () => {
            mockContextItemRepo.findAll.mockResolvedValue([
                { content: '', text: null },
                { content: null, text: '' },
            ]);
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Minimal analysis"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            const result = await processor.process(createMockJob({}) as never);

            expect(result.styleText).toBe('Minimal analysis');
            const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
            expect(requestBody.prompt).toBe('');
        });

        it('should use default prompt when no DNA_ANALYSIS template exists', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Fallback"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

            const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
            expect(requestBody.system_prompt).toContain('Analyze the following text samples');
        });

        it('should unmark previous latest report before creating new one', async () => {
            const previousReport = {
                id: 'old-report',
                isLatest: true,
            };
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(previousReport);
            mockDnaReportRepo.update.mockResolvedValue(previousReport);
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Style"}'),
            );
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'new-report',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

            expect(previousReport.isLatest).toBe(false);
            expect(mockDnaReportRepo.update).toHaveBeenCalledWith('old-report', previousReport);
        });

        it('should skip unmark step when no previous latest report exists', async () => {
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Style"}'),
            );
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'new-report',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

            expect(mockDnaReportRepo.update).not.toHaveBeenCalled();
        });

        it('should create report, version, DNA usage record, and prompt usage record (silent)', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS', currentVersionNumber: 2 },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{"key":"val"},"styleText":"Style"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'new-report',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({ id: 'new-version' });
            mockDnaUsageRepo.create.mockResolvedValue({ id: 'new-dna-usage' });
            mockPromptUsageRepo.create.mockResolvedValue({ id: 'new-prompt-usage' });

            await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

            expect(mockDnaReportRepo.create).toHaveBeenCalledTimes(1);
            expect(mockDnaVersionRepo.create).toHaveBeenCalledTimes(1);
            expect(mockDnaUsageRepo.create).toHaveBeenCalledTimes(1);
            expect(mockPromptUsageRepo.create).toHaveBeenCalledTimes(1);
        });

        it('should record PromptUsageRecord with correct template ID and version when DNA_ANALYSIS template is consumed', async () => {
            const { PromptUsageRecordFactory } = await import('@arcaai/domains');

            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'dna-tpl-42', content: 'Analyze style.', category: 'DNA_ANALYSIS', currentVersionNumber: 3 },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Style"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});
            mockPromptUsageRepo.create.mockResolvedValue({});

            await processor.process(
                createMockJob({
                    doctorId: 'doctor-77',
                    tenantId: 'tenant-88',
                    textSamples: ['sample'],
                }) as never,
            );

            expect(PromptUsageRecordFactory.CreatePromptUsageRecord).toHaveBeenCalledWith(
                expect.objectContaining({
                    tenantId: 'tenant-88',
                    doctorId: 'doctor-77',
                    promptTemplateId: 'dna-tpl-42',
                    promptVersionNumber: 3,
                }),
            );
            expect(mockPromptUsageRepo.create).toHaveBeenCalledTimes(1);
        });

        it('should NOT record PromptUsageRecord when no DNA_ANALYSIS template is found (fallback prompt used)', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Fallback"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

            expect(mockPromptUsageRepo.create).not.toHaveBeenCalled();
        });

        it('should report progress at all 5 steps (10, 20, 40, 80, 100)', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Style"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

            const progressValues = mockJobService.notifyProgress.mock.calls.map(
                (call: unknown[]) => (call as [string, number])[1],
            );
            expect(progressValues).toEqual([10, 20, 40, 80, 100]);
        });

        it('should call notifyComplete with reportId', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Style"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'saved-report-123',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

            expect(mockJobService.notifyComplete).toHaveBeenCalledWith('job-1', {
                reportId: 'saved-report-123',
            });
        });

        it('should use custom SMR URL from ConfigService', async () => {
            const customConfig = createMockConfigService();
            customConfig.get.mockReturnValue('http://custom-smr:9000');
            const customProcessor = new DnaWritingStyleProcessor(
                mockJobService as never,
                mockAppSettings as never,
                mockContextItemRepo as never,
                mockDnaReportRepo as never,
                mockDnaVersionRepo as never,
                mockDnaUsageRepo as never,
                mockPromptUsageRepo as never,
                mockPromptService as never,
                mockHttpService as never,
                customConfig as never,
                mockJobMetrics as never,
                mockClsService as never,
            );

            mockPromptService.listPromptTemplates.mockResolvedValue([]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Style"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await customProcessor.process(createMockJob({ textSamples: ['sample'] }) as never);

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                'http://custom-smr:9000/api/v1/generate',
                expect.any(Object),
                expect.any(Object),
            );
        });

        it('should use default SMR URL when config returns undefined', async () => {
            const noConfig = createMockConfigService();
            noConfig.get.mockReturnValue(undefined);
            const fallbackProcessor = new DnaWritingStyleProcessor(
                mockJobService as never,
                mockAppSettings as never,
                mockContextItemRepo as never,
                mockDnaReportRepo as never,
                mockDnaVersionRepo as never,
                mockDnaUsageRepo as never,
                mockPromptUsageRepo as never,
                mockPromptService as never,
                mockHttpService as never,
                noConfig as never,
                mockJobMetrics as never,
                mockClsService as never,
            );

            mockPromptService.listPromptTemplates.mockResolvedValue([]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Style"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await fallbackProcessor.process(createMockJob({ textSamples: ['sample'] }) as never);

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                'http://localhost:8862/api/v1/generate',
                expect.any(Object),
                expect.any(Object),
            );
        });

        it('should call DnaUsageRecordFactory with correct params', async () => {
            const { DnaUsageRecordFactory } = await import('@arcaai/domains');

            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Style"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'report-xyz',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await processor.process(
                createMockJob({
                    doctorId: 'doctor-99',
                    tenantId: 'tenant-42',
                    textSamples: ['sample text'],
                }) as never,
            );

            expect(DnaUsageRecordFactory.CreateDnaUsageRecord).toHaveBeenCalledWith(
                expect.objectContaining({
                    tenantId: 'tenant-42',
                    doctorId: 'doctor-99',
                    dnaReportId: 'report-xyz',
                    dnaVersionNumber: 1,
                }),
            );
        });
    });

    // ─── Context Limits (AppSettings) ─────────────────────────────

    describe('Context Limits from AppSettings', () => {
        it('should pass max-samples as limit to contextItemRepository.findAll', async () => {
            const limitedSettings = createMockAppSettingsService({ 'dna-regen.max-samples': 10 });
            const limitedProcessor = new DnaWritingStyleProcessor(
                mockJobService as never,
                limitedSettings as never,
                mockContextItemRepo as never,
                mockDnaReportRepo as never,
                mockDnaVersionRepo as never,
                mockDnaUsageRepo as never,
                mockPromptUsageRepo as never,
                mockPromptService as never,
                mockHttpService as never,
                mockConfigService as never,
                mockJobMetrics as never,
                mockClsService as never,
            );

            mockContextItemRepo.findAll.mockResolvedValue([
                { content: 'text-1', text: null },
            ]);
            mockPromptService.listPromptTemplates.mockResolvedValue([]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"OK"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await limitedProcessor.process(createMockJob({}) as never);

            expect(mockContextItemRepo.findAll).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 10 }),
            );
        });

        it('should truncate joined samples when exceeding max-context-chars', async () => {
            const tinyLimit = createMockAppSettingsService({ 'dna-regen.max-context-chars': 20 });
            const limitedProcessor = new DnaWritingStyleProcessor(
                mockJobService as never,
                tinyLimit as never,
                mockContextItemRepo as never,
                mockDnaReportRepo as never,
                mockDnaVersionRepo as never,
                mockDnaUsageRepo as never,
                mockPromptUsageRepo as never,
                mockPromptService as never,
                mockHttpService as never,
                mockConfigService as never,
                mockJobMetrics as never,
                mockClsService as never,
            );

            mockPromptService.listPromptTemplates.mockResolvedValue([]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Truncated"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            const longSamples = ['A'.repeat(50), 'B'.repeat(50)];
            await limitedProcessor.process(createMockJob({ textSamples: longSamples }) as never);

            const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
            expect(requestBody.prompt.length).toBeLessThanOrEqual(20);
        });

        it('should not truncate when samples are within max-context-chars', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"OK"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await processor.process(createMockJob({ textSamples: ['short text'] }) as never);

            const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
            expect(requestBody.prompt).toBe('short text');
        });

        it('should use default limits when AppSettings has no values', async () => {
            const emptySettings = createMockAppSettingsService({});
            emptySettings.getValueWithDefault.mockImplementation(
                <T>(_key: string, defaultValue: T): T => defaultValue,
            );
            const defaultProcessor = new DnaWritingStyleProcessor(
                mockJobService as never,
                emptySettings as never,
                mockContextItemRepo as never,
                mockDnaReportRepo as never,
                mockDnaVersionRepo as never,
                mockDnaUsageRepo as never,
                mockPromptUsageRepo as never,
                mockPromptService as never,
                mockHttpService as never,
                mockConfigService as never,
                mockJobMetrics as never,
                mockClsService as never,
            );

            mockContextItemRepo.findAll.mockResolvedValue([
                { content: 'text', text: null },
            ]);
            mockPromptService.listPromptTemplates.mockResolvedValue([]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"OK"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await defaultProcessor.process(createMockJob({}) as never);

            expect(mockContextItemRepo.findAll).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 50 }),
            );
        });
    });

    // ─── Error Handling ─────────────────────────────────────────

    describe('Error Handling', () => {
        it('should notify failed and re-throw when SMR call fails', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' },
            ]);
            mockHttpService.axiosRef.post.mockRejectedValue(new Error('Connection refused'));

            await expect(
                processor.process(createMockJob({ textSamples: ['sample'] }) as never),
            ).rejects.toThrow('Connection refused');

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'job-1',
                expect.stringContaining('Connection refused'),
            );
        });

        it('should notify failed and re-throw on SMR timeout', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([
                { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' },
            ]);
            mockHttpService.axiosRef.post.mockRejectedValue(new Error('timeout of 120000ms exceeded'));

            await expect(
                processor.process(createMockJob({ textSamples: ['sample'] }) as never),
            ).rejects.toThrow('timeout');

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'job-1',
                expect.stringContaining('timeout'),
            );
        });

        it('should throw when no text samples and no ContextItems found', async () => {
            mockContextItemRepo.findAll.mockResolvedValue([]);

            await expect(processor.process(createMockJob({}) as never)).rejects.toThrow(
                'No text samples available for DNA analysis',
            );

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'job-1',
                expect.stringContaining('No text samples'),
            );
        });

        it('should notify failed with correct jobId from payload', async () => {
            mockContextItemRepo.findAll.mockResolvedValue([]);

            try {
                await processor.process(createMockJob({ jobId: 'specific-job-42' }) as never);
            } catch {
                // expected
            }

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'specific-job-42',
                expect.any(String),
            );
        });
    });

    // ─── CLS Context Propagation ─────────────────────────────────

    describe('CLS Context Propagation', () => {
        it('should set tenantId in CLS context from job payload before calling services', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Style"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await processor.process(
                createMockJob({ tenantId: 'tenant-from-job', textSamples: ['sample'] }) as never,
            );

            expect(mockClsService.set).toHaveBeenCalledWith('tenantId', 'tenant-from-job');
        });

        it('should set userId in CLS context from job payload', async () => {
            mockPromptService.listPromptTemplates.mockResolvedValue([]);
            mockHttpService.axiosRef.post.mockResolvedValue(
                createAxiosSmrResponse('{"reportData":{},"styleText":"Style"}'),
            );
            mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockDnaReportRepo.create.mockResolvedValue({
                id: 'r',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockDnaVersionRepo.create.mockResolvedValue({});
            mockDnaUsageRepo.create.mockResolvedValue({});

            await processor.process(
                createMockJob({ userId: 'user-from-job', textSamples: ['sample'] }) as never,
            );

            expect(mockClsService.set).toHaveBeenCalledWith('user', expect.objectContaining({ id: 'user-from-job' }));
        });
    });
});
