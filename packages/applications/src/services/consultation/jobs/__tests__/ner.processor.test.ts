/**
 * NerProcessor Unit Tests
 *
 * Tests for the NerProcessor that handles async Named Entity Recognition jobs.
 * The processor loads a context item's content and calls the NLP service to extract entities.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { NamedEntityFactory } from '@arcaai/domains';
import { NerProcessor } from '../processors/ner.processor';
import { ExtractNerJobPayload, NerJobResult } from '../dto';

// Mock consultation job service
const createMockJobService = () => ({
    notifyProgress: vi.fn().mockResolvedValue(undefined),
    notifyComplete: vi.fn().mockResolvedValue(undefined),
    notifyFailed: vi.fn().mockResolvedValue(undefined),
});

// Mock repositories
const createMockContextItemRepository = () => ({
    findById: vi.fn(),
});

const createMockNamedEntityRepository = () => ({
    create: vi.fn(),
});

// Mock NamedEntityFactory
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        NamedEntityFactory: {
            CreateNamedEntity: vi.fn((data) => ({
                id: 'temp-id',
                tenantId: data.tenantId,
                contextItemId: data.contextItemId,
                text: data.text,
                className: data.className,
                confidence: data.confidence,
                startOffset: data.startOffset,
                endOffset: data.endOffset,
            })),
        },
    };
});

// Helper to create proper mock entity from factory input
const createEntityFromMock = (entity: any, id: string) => ({
    id,
    tenantId: entity.tenantId,
    contextItemId: entity.contextItemId,
    text: entity.text,
    className: entity.className,
    confidence: entity.confidence,
    startOffset: entity.startOffset,
    endOffset: entity.endOffset,
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
        if (key === 'NLP_URL') return 'http://localhost:8864';
        return undefined;
    }),
});

// Mock EventEmitter2
const createMockEventEmitter = () => ({
    emit: vi.fn(),
});

// Mock ClsService. See summary.processor.test.ts for the
// rationale.
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

// Helper to create mock job
const createMockJob = (data: ExtractNerJobPayload): Job<ExtractNerJobPayload> =>
    ({
        data,
        id: data.jobId,
        name: 'extract',
    }) as unknown as Job<ExtractNerJobPayload>;

// Helper to create mock context item
const createMockContextItem = (overrides: Partial<any> = {}) => ({
    id: overrides.id ?? 'ctx-item-123',
    consultationId: overrides.consultationId ?? 'consultation-123',
    type: overrides.type ?? 'TRANSCRIPT',
    content: overrides.content ?? 'Patient John Doe, age 45, diagnosed with Type 2 Diabetes. Prescribed Metformin 500mg.',
    tenantId: overrides.tenantId ?? 'tenant-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
});

// Helper to create mock named entity
const createMockNamedEntity = (overrides: Partial<any> = {}) => ({
    id: overrides.id ?? 'entity-123',
    tenantId: overrides.tenantId ?? 'tenant-1',
    contextItemId: overrides.contextItemId ?? 'ctx-item-123',
    text: overrides.text ?? 'John Doe',
    className: overrides.className ?? 'PERSON',
    confidence: overrides.confidence ?? 0.95,
    startOffset: overrides.startOffset ?? 8,
    endOffset: overrides.endOffset ?? 16,
    ...overrides,
});

// =============================================================================
// Realistic Mock Data Factories - These match actual NLP service responses
// =============================================================================

/**
 * Creates a realistic NLP service response matching the actual API structure.
 * This prevents Anti-Pattern #4: Incomplete Mocks
 */
const createRealisticNlpResponse = (entities: Array<{
    type: string;
    value: string;
    confidence?: number;
    start?: number;
    end?: number;
}> = []) => ({
    entities: entities.length > 0 ? entities : [
        { type: 'PERSON', value: 'John Doe', confidence: 0.95, start: 8, end: 16 },
        { type: 'AGE', value: '45', confidence: 0.92, start: 23, end: 25 },
        { type: 'CONDITION', value: 'Type 2 Diabetes', confidence: 0.98, start: 42, end: 57 },
        { type: 'MEDICATION', value: 'Metformin', confidence: 0.97, start: 70, end: 79 },
        { type: 'DOSAGE', value: '500mg', confidence: 0.94, start: 80, end: 85 },
    ],
    processingTimeMs: 156,
    modelVersion: 'ner-medical-v2.1',
    requestId: 'nlp-req-abc123',
});

/**
 * Creates realistic medical text content for NER extraction
 */
const createRealisticMedicalText = () =>
    'Patient John Smith, a 67-year-old male, presents with chest pain radiating to the left arm. ' +
    'History includes hypertension and Type 2 Diabetes. Currently taking Metoprolol 50mg BID and ' +
    'Metformin 1000mg daily. Vitals: BP 145/92, HR 78, SpO2 97%. Assessment: Unstable angina. ' +
    'Plan: Admit for observation, cardiac enzymes, and stress test.';

describe('NerProcessor', () => {
    let processor: NerProcessor;
    let mockJobService: ReturnType<typeof createMockJobService>;
    let mockContextItemRepository: ReturnType<typeof createMockContextItemRepository>;
    let mockNamedEntityRepository: ReturnType<typeof createMockNamedEntityRepository>;
    let mockHttpService: ReturnType<typeof createMockHttpService>;
    let mockConfigService: ReturnType<typeof createMockConfigService>;
    let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
    let mockClsService: ReturnType<typeof createMockClsService>;

    beforeEach(() => {
        vi.clearAllMocks();

        mockJobService = createMockJobService();
        mockContextItemRepository = createMockContextItemRepository();
        mockNamedEntityRepository = createMockNamedEntityRepository();
        mockHttpService = createMockHttpService();
        mockConfigService = createMockConfigService();
        mockEventEmitter = createMockEventEmitter();
        mockClsService = createMockClsService();

        processor = new NerProcessor(
            mockJobService as any,
            mockContextItemRepository as any,
            mockNamedEntityRepository as any,
            mockHttpService as any,
            mockConfigService as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    // ===========================================================================
    // Successful Processing Tests
    // ===========================================================================

    describe('Successful Job Processing', () => {
        it('should process NER job and extract entities', async () => {
            const contextItem = createMockContextItem({
                content: 'Patient John Doe, age 45, diagnosed with Type 2 Diabetes.',
            });

            mockContextItemRepository.findById.mockResolvedValue(contextItem);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'PERSON', value: 'John Doe', confidence: 0.95, start: 8, end: 16 },
                        { type: 'AGE', value: '45', confidence: 0.92, start: 23, end: 25 },
                        { type: 'CONDITION', value: 'Type 2 Diabetes', confidence: 0.98, start: 42, end: 57 },
                    ],
                },
            });

            // Mock create returning entities with IDs and proper structure
            let entityCounter = 0;
            mockNamedEntityRepository.create.mockImplementation((entity) => ({
                id: `entity-${++entityCounter}`,
                tenantId: entity.tenantId,
                contextItemId: entity.contextItemId,
                text: entity.text,
                className: entity.className,
                confidence: entity.confidence,
                startOffset: entity.startOffset,
                endOffset: entity.endOffset,
            }));

            const payload: ExtractNerJobPayload = {
                jobId: 'job-123',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            const result = await processor.process(createMockJob(payload));

            expect(result.contextItemId).toBe('ctx-item-123');
            expect(result.namedEntities).toHaveLength(3);
            expect(result.namedEntities[0]).toMatchObject({
                entityType: 'PERSON',
                value: 'John Doe',
                confidence: 0.95,
            });

            expect(mockJobService.notifyProgress).toHaveBeenCalledTimes(3);
            expect(mockJobService.notifyComplete).toHaveBeenCalledWith('job-123', result);
            expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(3);
        });

        it('should notify progress at each step', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test content with entities' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: [{ type: 'PERSON', value: 'Test', confidence: 0.9 }] },
            });
            mockNamedEntityRepository.create.mockImplementation((entity) =>
                createEntityFromMock(entity, 'entity-1'),
            );

            const payload: ExtractNerJobPayload = {
                jobId: 'job-progress',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await processor.process(createMockJob(payload));

            expect(mockJobService.notifyProgress).toHaveBeenNthCalledWith(
                1,
                'job-progress',
                10,
                'Loading content',
            );
            expect(mockJobService.notifyProgress).toHaveBeenNthCalledWith(
                2,
                'job-progress',
                30,
                'Extracting named entities',
            );
            expect(mockJobService.notifyProgress).toHaveBeenNthCalledWith(
                3,
                'job-progress',
                70,
                'Saving entities',
            );
        });

        it('should send correct payload to NLP service', async () => {
            const content = 'Patient presenting with chest pain and shortness of breath.';
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: [] },
            });

            const payload: ExtractNerJobPayload = {
                jobId: 'job-nlp',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await processor.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                'http://localhost:8864/api/v1/classify/tokens',
                { text: content },
                { timeout: 60000 },
            );
        });

        it('should create named entities with correct factory data', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        {
                            type: 'MEDICATION',
                            value: 'Aspirin',
                            confidence: 0.97,
                            start: 10,
                            end: 17,
                        },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockImplementation((entity) =>
                createEntityFromMock(entity, 'entity-med-1'),
            );

            const payload: ExtractNerJobPayload = {
                jobId: 'job-factory',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await processor.process(createMockJob(payload));

            // Verify the factory was called with correct parameters
            expect(mockNamedEntityRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    tenantId: 'tenant-1',
                    contextItemId: 'ctx-item-123',
                    text: 'Aspirin',
                    className: 'MEDICATION',
                    confidence: 0.97,
                    startOffset: 10,
                    endOffset: 17,
                }),
            );
        });

        it('should handle entities without confidence or positions', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'SYMPTOM', value: 'headache' },
                        { type: 'MEDICATION', value: 'ibuprofen', confidence: 0.85 },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockImplementation((entity) =>
                createEntityFromMock(entity, `entity-${entity.text}`),
            );

            const payload: ExtractNerJobPayload = {
                jobId: 'job-partial',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            const result = await processor.process(createMockJob(payload));

            expect(result.namedEntities).toHaveLength(2);
            expect(result.namedEntities[0].confidence).toBeUndefined();
            expect(result.namedEntities[0].startPosition).toBeUndefined();
            expect(result.namedEntities[1].confidence).toBe(0.85);
        });

        it('should return empty entities array when no entities found', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Simple text without entities' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: [] },
            });

            const payload: ExtractNerJobPayload = {
                jobId: 'job-empty',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            const result = await processor.process(createMockJob(payload));

            expect(result.namedEntities).toEqual([]);
            expect(mockNamedEntityRepository.create).not.toHaveBeenCalled();
            expect(mockJobService.notifyComplete).toHaveBeenCalledWith('job-empty', {
                contextItemId: 'ctx-item-123',
                namedEntities: [],
            });
        });
    });

    // ===========================================================================
    // Error Handling Tests
    // ===========================================================================

    describe('Error Handling', () => {
        it('should fail when context item not found', async () => {
            mockContextItemRepository.findById.mockResolvedValue(null);

            const payload: ExtractNerJobPayload = {
                jobId: 'job-not-found',
                contextItemId: 'non-existent',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Context item non-existent not found',
            );

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'job-not-found',
                'Context item non-existent not found',
            );
        });

        it('should fail when context item has no content', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: '' }),
            );

            const payload: ExtractNerJobPayload = {
                jobId: 'job-no-content',
                contextItemId: 'ctx-item-empty',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Context item has no content for NER extraction',
            );

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'job-no-content',
                'Context item has no content for NER extraction',
            );
        });

        it('should fail when context item has only whitespace content', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: '   \n\t  ' }),
            );

            const payload: ExtractNerJobPayload = {
                jobId: 'job-whitespace',
                contextItemId: 'ctx-item-ws',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Context item has no content for NER extraction',
            );
        });

        it('should fail when context item content is null', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: null }),
            );

            const payload: ExtractNerJobPayload = {
                jobId: 'job-null-content',
                contextItemId: 'ctx-item-null',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Context item has no content for NER extraction',
            );
        });

        it('should fail when NLP service call fails', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Valid content' }),
            );
            mockHttpService.axiosRef.post.mockRejectedValue(new Error('Connection refused'));

            const payload: ExtractNerJobPayload = {
                jobId: 'job-nlp-error',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Failed to extract named entities from NLP service',
            );

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'job-nlp-error',
                'Failed to extract named entities from NLP service',
            );
        });

        it('should fail when NLP service returns 500 error', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Valid content' }),
            );
            mockHttpService.axiosRef.post.mockRejectedValue({
                response: { status: 500, data: { error: 'Model loading failed' } },
                message: 'Request failed with status 500',
            });

            const payload: ExtractNerJobPayload = {
                jobId: 'job-nlp-500',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Failed to extract named entities from NLP service',
            );
        });

        it('should fail when NLP service times out', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Valid content' }),
            );
            mockHttpService.axiosRef.post.mockRejectedValue({
                code: 'ETIMEDOUT',
                message: 'timeout of 60000ms exceeded',
            });

            const payload: ExtractNerJobPayload = {
                jobId: 'job-timeout',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Failed to extract named entities from NLP service',
            );
        });

        it('should fail when entity repository create fails', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Valid content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [{ type: 'PERSON', value: 'Test', confidence: 0.9 }],
                },
            });
            mockNamedEntityRepository.create.mockRejectedValue(
                new Error('Database constraint violation'),
            );

            const payload: ExtractNerJobPayload = {
                jobId: 'job-db-error',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Database constraint violation',
            );

            expect(mockJobService.notifyFailed).toHaveBeenCalledWith(
                'job-db-error',
                'Database constraint violation',
            );
        });

        it('should fail on second entity if first succeeds but second fails', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Valid content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'PERSON', value: 'Test1', confidence: 0.9 },
                        { type: 'MEDICATION', value: 'Test2', confidence: 0.85 },
                    ],
                },
            });
            mockNamedEntityRepository.create
                .mockResolvedValueOnce({ id: 'entity-1', text: 'Test1', className: 'PERSON' })
                .mockRejectedValueOnce(new Error('Duplicate entity'));

            const payload: ExtractNerJobPayload = {
                jobId: 'job-partial-fail',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                'Duplicate entity',
            );

            expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(2);
        });
    });

    // ===========================================================================
    // Edge Cases Tests
    // ===========================================================================

    describe('Edge Cases', () => {
        it('should use default NLP URL when not configured', async () => {
            const configServiceWithoutUrl = {
                get: vi.fn().mockReturnValue(undefined),
            };

            const processorWithDefaultUrl = new NerProcessor(
                mockJobService as any,
                mockContextItemRepository as any,
                mockNamedEntityRepository as any,
                mockHttpService as any,
                configServiceWithoutUrl as any,
                mockEventEmitter as any,
                mockClsService as any,
            );

            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: [] },
            });

            const payload: ExtractNerJobPayload = {
                jobId: 'job-default-url',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await processorWithDefaultUrl.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                'http://localhost:8864/api/v1/classify/tokens',
                expect.any(Object),
                expect.any(Object),
            );
        });

        it('should handle very long content', async () => {
            const longContent = 'Patient ' + 'symptom description '.repeat(5000);
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: longContent }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: [{ type: 'PERSON', value: 'Patient', confidence: 0.8 }] },
            });
            mockNamedEntityRepository.create.mockImplementation((entity) =>
                createEntityFromMock(entity, 'entity-1'),
            );

            const payload: ExtractNerJobPayload = {
                jobId: 'job-long',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await processor.process(createMockJob(payload));

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                expect.any(String),
                { text: longContent },
                expect.any(Object),
            );
        });

        it('should handle content with special characters and unicode', async () => {
            const specialContent = `
Patient: José García-Müller
Diagnosis: COVID-19 (SARS-CoV-2)
Temperature: 38.5°C
Notes: "Alert" & oriented ×3
Chinese: 發燒 (fever)
            `.trim();

            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: specialContent }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'PERSON', value: 'José García-Müller', confidence: 0.95 },
                        { type: 'CONDITION', value: 'COVID-19', confidence: 0.99 },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockImplementation((entity) =>
                createEntityFromMock(entity, `entity-${entity.text}`),
            );

            const payload: ExtractNerJobPayload = {
                jobId: 'job-special',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            const result = await processor.process(createMockJob(payload));

            expect(result.namedEntities).toHaveLength(2);
            expect(result.namedEntities[0].value).toBe('José García-Müller');
        });

        it('should handle many entities', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Long medical document' }),
            );

            // Generate 50 entities
            const entities = Array.from({ length: 50 }, (_, i) => ({
                type: i % 5 === 0 ? 'PERSON' : i % 5 === 1 ? 'MEDICATION' : i % 5 === 2 ? 'CONDITION' : i % 5 === 3 ? 'SYMPTOM' : 'PROCEDURE',
                value: `Entity${i}`,
                confidence: 0.9 + (i % 10) / 100,
                start: i * 20,
                end: i * 20 + 10,
            }));

            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities },
            });

            let entityCounter = 0;
            mockNamedEntityRepository.create.mockImplementation((entity) =>
                createEntityFromMock(entity, `entity-${++entityCounter}`),
            );

            const payload: ExtractNerJobPayload = {
                jobId: 'job-many',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            const result = await processor.process(createMockJob(payload));

            expect(result.namedEntities).toHaveLength(50);
            expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(50);
        });

        it('should handle overlapping entity positions', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Dr. John Smith prescribed medication' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'TITLE', value: 'Dr.', confidence: 0.9, start: 0, end: 3 },
                        { type: 'PERSON', value: 'Dr. John Smith', confidence: 0.95, start: 0, end: 14 },
                        { type: 'PERSON', value: 'John Smith', confidence: 0.93, start: 4, end: 14 },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockImplementation((entity) =>
                createEntityFromMock(entity, `entity-${entity.text}`),
            );

            const payload: ExtractNerJobPayload = {
                jobId: 'job-overlap',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            const result = await processor.process(createMockJob(payload));

            // All entities should be saved, even if overlapping
            expect(result.namedEntities).toHaveLength(3);
        });

        it('should handle entity types with various formats', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'PERSON', value: 'Test1' },
                        { type: 'person', value: 'Test2' },
                        { type: 'Person_Name', value: 'Test3' },
                        { type: 'B-PERSON', value: 'Test4' },
                        { type: 'I-MEDICATION', value: 'Test5' },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockImplementation((entity) =>
                createEntityFromMock(entity, `entity-${entity.text}`),
            );

            const payload: ExtractNerJobPayload = {
                jobId: 'job-types',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            const result = await processor.process(createMockJob(payload));

            expect(result.namedEntities).toHaveLength(5);
            expect(result.namedEntities.map((e) => e.entityType)).toEqual([
                'PERSON',
                'person',
                'Person_Name',
                'B-PERSON',
                'I-MEDICATION',
            ]);
        });

        it('should handle zero confidence values', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'UNCERTAIN', value: 'MaybeEntity', confidence: 0, start: 0, end: 10 },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockImplementation((entity) =>
                createEntityFromMock(entity, 'entity-1'),
            );

            const payload: ExtractNerJobPayload = {
                jobId: 'job-zero-conf',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            const result = await processor.process(createMockJob(payload));

            expect(result.namedEntities[0].confidence).toBe(0);
        });

        it('should handle callback URL in payload (even though not used by processor)', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: [] },
            });

            const payload: ExtractNerJobPayload = {
                jobId: 'job-callback',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
                callbackUrl: 'https://example.com/callback',
            };

            const result = await processor.process(createMockJob(payload));

            // Callback URL is in payload but processor doesn't use it directly
            // (it's handled elsewhere)
            expect(result.contextItemId).toBe('ctx-item-123');
        });
    });

    // ===========================================================================
    // Behavior Verification Tests (Anti-Pattern #1 Prevention)
    // These tests verify actual output behavior, not just mock interactions
    // ===========================================================================

    describe('Behavior Verification', () => {
        it('should extract and return all entities from NLP response with correct structure', async () => {
            const medicalText = createRealisticMedicalText();
            const nlpEntities = [
                { type: 'PERSON', value: 'John Smith', confidence: 0.96, start: 8, end: 18 },
                { type: 'AGE', value: '67-year-old', confidence: 0.94, start: 22, end: 33 },
                { type: 'CONDITION', value: 'chest pain', confidence: 0.91, start: 53, end: 63 },
                { type: 'CONDITION', value: 'hypertension', confidence: 0.97, start: 102, end: 114 },
                { type: 'MEDICATION', value: 'Metoprolol', confidence: 0.98, start: 158, end: 168 },
            ];

            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: medicalText }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: createRealisticNlpResponse(nlpEntities),
            });

            let savedCount = 0;
            mockNamedEntityRepository.create.mockImplementation((entity) => {
                savedCount++;
                return createEntityFromMock(entity, `entity-${savedCount}`);
            });

            // Act
            const result = await processor.process(createMockJob({
                jobId: 'job-verify-entities',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            }));

            // Assert: Verify result structure matches expected output
            expect(result.namedEntities).toHaveLength(5);
            expect(result.namedEntities[0]).toEqual({
                id: 'entity-1',
                entityType: 'PERSON',
                value: 'John Smith',
                confidence: 0.96,
                startPosition: 8,
                endPosition: 18,
            });

            // Verify all entities were processed
            expect(savedCount).toBe(5);
        });

        it('should preserve entity type exactly as returned by NLP service', async () => {
            const customEntityTypes = [
                { type: 'SYMPTOM_CARDIOVASCULAR', value: 'chest pain', confidence: 0.9 },
                { type: 'MEDICATION_DOSAGE', value: '50mg BID', confidence: 0.88 },
                { type: 'VITAL_SIGN', value: 'BP 145/92', confidence: 0.95 },
            ];

            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: createRealisticNlpResponse(customEntityTypes),
            });
            mockNamedEntityRepository.create.mockImplementation((entity) =>
                createEntityFromMock(entity, `entity-${entity.text}`),
            );

            // Act
            const result = await processor.process(createMockJob({
                jobId: 'job-entity-types',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            }));

            // Assert: Entity types are preserved exactly
            expect(result.namedEntities.map(e => e.entityType)).toEqual([
                'SYMPTOM_CARDIOVASCULAR',
                'MEDICATION_DOSAGE',
                'VITAL_SIGN',
            ]);
        });

        it('should send correct content to NLP service', async () => {
            const inputContent = createRealisticMedicalText();

            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: inputContent }),
            );

            // Capture what was sent to NLP - return empty entities array
            let sentContent = '';
            mockHttpService.axiosRef.post.mockImplementation(async (_url, payload) => {
                sentContent = payload.text;
                return { data: { entities: [] } };
            });

            // Act
            await processor.process(createMockJob({
                jobId: 'job-verify-send',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            }));

            // Assert: Exact content was sent
            expect(sentContent).toBe(inputContent);
        });

        it('should persist entities with correct contextItemId association', async () => {
            const contextItemId = 'specific-context-item-id';

            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ id: contextItemId, content: 'Test' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: createRealisticNlpResponse([
                    { type: 'PERSON', value: 'Test', confidence: 0.9 },
                ]),
            });

            // Track what contextItemId was passed to repository
            const createdContextItemIds: string[] = [];
            mockNamedEntityRepository.create.mockImplementation((entity) => {
                createdContextItemIds.push(entity.contextItemId);
                return createEntityFromMock(entity, 'entity-1');
            });

            // Act
            const result = await processor.process(createMockJob({
                jobId: 'job-context-assoc',
                contextItemId,
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            }));

            // Assert: Entity was associated with correct context item
            expect(createdContextItemIds[0]).toBe(contextItemId);
            expect(result.contextItemId).toBe(contextItemId);
        });

        it('should complete full processing cycle with realistic medical data', async () => {
            const medicalContent = createRealisticMedicalText();
            const expectedEntities = [
                { type: 'PERSON', value: 'John Smith', confidence: 0.96, start: 8, end: 18 },
                { type: 'CONDITION', value: 'chest pain', confidence: 0.91, start: 53, end: 63 },
                { type: 'CONDITION', value: 'hypertension', confidence: 0.97, start: 102, end: 114 },
                { type: 'CONDITION', value: 'Type 2 Diabetes', confidence: 0.95, start: 119, end: 134 },
                { type: 'MEDICATION', value: 'Metoprolol', confidence: 0.98, start: 158, end: 168 },
                { type: 'DOSAGE', value: '50mg BID', confidence: 0.92, start: 169, end: 177 },
                { type: 'MEDICATION', value: 'Metformin', confidence: 0.97, start: 182, end: 191 },
                { type: 'DOSAGE', value: '1000mg daily', confidence: 0.93, start: 192, end: 204 },
            ];

            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: medicalContent, tenantId: 'tenant-medical' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: createRealisticNlpResponse(expectedEntities),
            });

            let entityIndex = 0;
            mockNamedEntityRepository.create.mockImplementation((entity) =>
                createEntityFromMock(entity, `entity-${++entityIndex}`),
            );

            // Act
            const result = await processor.process(createMockJob({
                jobId: 'job-full-cycle',
                contextItemId: 'ctx-medical',
                consultationId: 'consultation-medical',
                tenantId: 'tenant-medical',
                userId: 'user-1',
            }));

            // Assert: Complete result verification
            expect(result.contextItemId).toBe('ctx-medical');
            expect(result.namedEntities).toHaveLength(8);

            // Verify key medical entities were extracted
            const conditions = result.namedEntities.filter(e => e.entityType === 'CONDITION');
            expect(conditions).toHaveLength(3);
            expect(conditions.map(c => c.value)).toContain('chest pain');
            expect(conditions.map(c => c.value)).toContain('hypertension');

            const medications = result.namedEntities.filter(e => e.entityType === 'MEDICATION');
            expect(medications).toHaveLength(2);

            // Verify notification sequence
            expect(mockJobService.notifyComplete).toHaveBeenCalledWith('job-full-cycle', result);
        });
    });

    // ===========================================================================
    // NerExtracted Pipeline Event Emission
    // ===========================================================================

    describe('NerExtracted pipeline event', () => {
        const setupSuccessfulNerJob = (entities: Array<{ type: string; value: string; confidence?: number; start?: number; end?: number }>) => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Patient has diabetes and hypertension.' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities },
            });

            let entityCounter = 0;
            mockNamedEntityRepository.create.mockImplementation(async (entity: any) => ({
                id: `entity-${++entityCounter}`,
                tenantId: entity.tenantId,
                contextItemId: entity.contextItemId,
                text: entity.text,
                className: entity.className,
                confidence: entity.confidence,
                startOffset: entity.startOffset,
                endOffset: entity.endOffset,
            }));
        };

        it('should emit NerExtracted event after successful processing', async () => {
            setupSuccessfulNerJob([
                { type: 'CONDITION', value: 'diabetes', confidence: 0.95, start: 16, end: 24 },
                { type: 'CONDITION', value: 'hypertension', confidence: 0.92, start: 29, end: 41 },
            ]);

            const payload: ExtractNerJobPayload = {
                jobId: 'ner-job-001',
                contextItemId: 'ctx-item-001',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
            };

            await processor.process(createMockJob(payload));

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'consultation.ner.extracted',
                expect.objectContaining({
                    consultationId: 'consultation-123',
                    tenantId: 'tenant-1',
                    userId: 'doctor-1',
                    contextItemId: 'ctx-item-001',
                    jobId: 'ner-job-001',
                    entityCount: 2,
                }),
            );
        });

        it('should include entityCountByClass breakdown', async () => {
            setupSuccessfulNerJob([
                { type: 'CONDITION', value: 'diabetes' },
                { type: 'CONDITION', value: 'hypertension' },
                { type: 'MEDICATION', value: 'Metformin' },
            ]);

            const payload: ExtractNerJobPayload = {
                jobId: 'ner-job-001',
                contextItemId: 'ctx-item-001',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
            };

            await processor.process(createMockJob(payload));

            const pipelineCall = mockEventEmitter.emit.mock.calls.find(
                (c: any[]) => c[0] === 'consultation.ner.extracted',
            );
            expect(pipelineCall).toBeDefined();
            expect(pipelineCall![1].entityCountByClass).toEqual({
                CONDITION: 2,
                MEDICATION: 1,
            });
        });

        it('should set isAutoGenerated=true when no callbackUrl', async () => {
            setupSuccessfulNerJob([{ type: 'CONDITION', value: 'diabetes' }]);

            const payload: ExtractNerJobPayload = {
                jobId: 'ner-job-001',
                contextItemId: 'ctx-item-001',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                // No callbackUrl
            };

            await processor.process(createMockJob(payload));

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'consultation.ner.extracted',
                expect.objectContaining({
                    isAutoGenerated: true,
                }),
            );
        });

        it('should set isAutoGenerated=false when callbackUrl is present', async () => {
            setupSuccessfulNerJob([{ type: 'CONDITION', value: 'diabetes' }]);

            const payload: ExtractNerJobPayload = {
                jobId: 'ner-job-001',
                contextItemId: 'ctx-item-001',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                callbackUrl: 'http://frontend/callback',
            };

            await processor.process(createMockJob(payload));

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'consultation.ner.extracted',
                expect.objectContaining({
                    isAutoGenerated: false,
                }),
            );
        });

        it('should emit event with entityCount=0 when no entities found', async () => {
            setupSuccessfulNerJob([]);

            const payload: ExtractNerJobPayload = {
                jobId: 'ner-job-001',
                contextItemId: 'ctx-item-001',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
            };

            await processor.process(createMockJob(payload));

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'consultation.ner.extracted',
                expect.objectContaining({
                    entityCount: 0,
                    entityCountByClass: {},
                }),
            );
        });

        it('should NOT emit event when processing fails', async () => {
            mockContextItemRepository.findById.mockResolvedValue(null);

            const payload: ExtractNerJobPayload = {
                jobId: 'ner-job-001',
                contextItemId: 'ctx-item-001',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow();

            const pipelineCalls = mockEventEmitter.emit.mock.calls.filter(
                (c: any[]) => c[0] === 'consultation.ner.extracted',
            );
            expect(pipelineCalls).toHaveLength(0);
        });

        it('should include ISO timestamp in event payload', async () => {
            setupSuccessfulNerJob([{ type: 'CONDITION', value: 'diabetes' }]);

            const payload: ExtractNerJobPayload = {
                jobId: 'ner-job-001',
                contextItemId: 'ctx-item-001',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'doctor-1',
            };

            await processor.process(createMockJob(payload));

            const pipelineCall = mockEventEmitter.emit.mock.calls.find(
                (c: any[]) => c[0] === 'consultation.ner.extracted',
            );
            const ts = pipelineCall![1].timestamp;
            expect(ts).toBeDefined();
            expect(new Date(ts).toISOString()).toBe(ts);
        });
    });

    // ===========================================================================
    // CLS rebind + tenant assert + fail-closed guard
    // ===========================================================================

    describe('CLS rebind + tenant assert', () => {
        const setupSuccessfulJob = (contextItemOverrides: Record<string, unknown> = {}) => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'medical content', ...contextItemOverrides }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: [] },
            });
        };

        it('wraps process() in cls.run with tenantId + user set before any work runs', async () => {
            setupSuccessfulJob({ tenantId: 'tenant-A' });
            const setOrder: Array<[string, unknown]> = [];
            mockClsService.set.mockImplementation((key: string, value: unknown) => {
                setOrder.push([key, value]);
            });

            const payload: ExtractNerJobPayload = {
                jobId: 'job-cls-1',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-A',
                userId: 'user-A',
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
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                userId: 'user-1',
            } as unknown as ExtractNerJobPayload;

            await expect(processor.process(createMockJob(payload))).rejects.toThrow(
                /tenantId/i,
            );
            expect(mockContextItemRepository.findById).not.toHaveBeenCalled();
        });

        it('throws when loaded contextItem.tenantId differs from job.data.tenantId', async () => {
            setupSuccessfulJob({ tenantId: 'tenant-OTHER' });

            const payload: ExtractNerJobPayload = {
                jobId: 'job-mismatch',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-A',
                userId: 'user-A',
            };

            await expect(processor.process(createMockJob(payload))).rejects.toThrow();
            expect(mockNamedEntityRepository.create).not.toHaveBeenCalled();
            expect(mockJobService.notifyFailed).toHaveBeenCalled();
        });
    });

    // ===========================================================================
    // Durable NamedEntity persistence from the REAL NLP contract.
    // The NLP /classify/tokens service emits { text, entity_type, confidence,
    // position: { start, end } } (canonical: apps/nlp/src/nlp/schemas/common.py).
    // This path previously read the phantom { value, type, start, end } shape and
    // persisted blank/null text/className/offsets.
    // ===========================================================================

    describe('real NLP contract persistence', () => {
        it('persists text/className/offsets from the real NLP entity contract', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Take aspirin now' }),
            );
            // Realistic NLP response — the REAL snake_case contract, not the phantom shape.
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { text: 'aspirin', entity_type: 'MEDICATION', confidence: 0.9, position: { start: 8, end: 15 } },
                    ],
                },
            });

            let created: any;
            mockNamedEntityRepository.create.mockImplementation((entity: any) => {
                created = entity;
                return { ...entity, id: 'ne-463' };
            });

            const payload: ExtractNerJobPayload = {
                jobId: 'job-463',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            };

            await processor.process(createMockJob(payload));

            expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(1);
            expect(created).toMatchObject({
                text: 'aspirin',
                className: 'MEDICATION',
                confidence: 0.9,
                startOffset: 8,
                endOffset: 15,
            });
        });
    });

    // ===========================================================================
    // (AC-3a) — the async durable path persists the ontology codes
    // the NLP producer now emits. The codes flow through the shared mapper
    // (namedEntityPropsFromNlp) into the factory; RED before the mapper maps them.
    // ===========================================================================

    describe('ontology code persistence (async path)', () => {
        it('passes the NLP ontology codes into the NamedEntity factory', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Take metformin daily' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        {
                            text: 'metformin',
                            entity_type: 'MEDICATION',
                            confidence: 0.97,
                            position: { start: 5, end: 14 },
                            umls_cui: 'C0025598',
                            rxnorm_code: '6809',
                            snomed_code: null,
                            icd_code: null,
                            loinc_code: null,
                        },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockImplementation((entity: any) => ({ ...entity, id: 'ne-476' }));

            await processor.process(createMockJob({
                jobId: 'job-476',
                contextItemId: 'ctx-item-123',
                consultationId: 'consultation-123',
                tenantId: 'tenant-1',
                userId: 'user-1',
            }));

            expect(NamedEntityFactory.CreateNamedEntity).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: 'metformin',
                    className: 'MEDICATION',
                    umlsCui: 'C0025598',
                    rxnormCode: '6809',
                }),
            );
        });
    });
});
