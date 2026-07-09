/**
 * SummaryService Unit Tests — extractEntities (GAP-5 Fix)
 *
 * Tests for the sync NER extraction path. The core behavior under test:
 * extractEntities() must call the NLP service AND persist entities to the database,
 * not just broadcast a SysEvent.
 *
 * Pattern follows: ner.processor.test.ts and context.service.test.ts conventions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { SummaryService } from '../summary.service';
import { SysEventType, ContextItemVersionFactory, HarnessAuditAction, ConsultationStatus } from '@arcaai/domains';

// Mock domain factories — same approach as ner.processor.test.ts
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
        ContextItemVersionFactory: {
            CreateFromContextItem: vi.fn(
                (contextItem, versionNumber, changeReason, changedBy, changeSource, changeSummary) => ({
                    id: 'version-id-1',
                    contextItemId: contextItem.id,
                    versionNumber,
                    content: contextItem.content,
                    changeReason,
                    changedBy,
                    changeSource: changeSource ?? 'manual',
                    changeSummary: changeSummary ?? null,
                    tenantId: contextItem.tenantId,
                    createdAt: new Date('2026-06-06T00:00:00.000Z'),
                }),
            ),
            // TASK-330 Phase 1 — attested SIGNED_NOTE version used by approveSummary.
            CreateSignedNoteVersion: vi.fn((props) => ({
                id: 'signed-version-id-1',
                contextItemId: props.contextItemId,
                versionNumber: props.versionNumber,
                content: props.content ?? null,
                changeReason: props.changeReason ?? 'approved',
                changeSummary: props.changeSummary ?? 'Clinician attested signed note',
                changedBy: props.attestedBy,
                changeSource: 'attestation',
                attestedAt: props.attestedAt ?? new Date('2026-06-06T00:00:00.000Z'),
                attestedBy: props.attestedBy,
                attestationHash: props.attestationHash,
                modelName: props.modelName ?? null,
                modelVersion: props.modelVersion ?? null,
                sensorScores: props.sensorScores ?? null,
                tenantId: props.tenantId,
                createdAt: new Date('2026-06-06T00:00:00.000Z'),
            })),
        },
    };
});

// ============================================
// Mock Factories
// ============================================

const createMockClsService = () => ({
    get: vi.fn().mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-1';
        if (key === 'user') return { id: 'user-1', firstName: 'Test', lastName: 'User' };
        return null;
    }),
    set: vi.fn(),
});

const createMockEventEmitter = () => ({
    emit: vi.fn(),
});

const createMockContextItemRepository = () => ({
    findById: vi.fn(),
    findCaseNotes: vi.fn(),
    findTranscripts: vi.fn(),
    findSummaries: vi.fn(),
    findLatestModifiedSummary: vi.fn(),
    findLatestRawSummary: vi.fn(),
    findLatestPreSummary: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
});

const createMockConsultationRepository = () => ({
    findById: vi.fn(),
    update: vi.fn(),
});

// TASK-330 Phase 1 — Phase-0 WORM audit service (attestation gate).
const createMockHarnessAuditService = () => ({
    append: vi.fn().mockResolvedValue({ id: 'audit-evt-1' }),
});

// TASK-330 Phase 1 (Lane G) — outbound harness gate adapter. approveSummary
// forwards the sign-off to the harness best-effort (after the WORM write).
const createMockHarnessGatewayService = () => ({
    start: vi.fn().mockResolvedValue({ workflowId: 'wf-1' }),
    signalApproval: vi.fn().mockResolvedValue({ ok: true }),
    // TASK-355 Phase D (Slice 5c) — updateSummary forwards a clinician edit of an
    // optimistically-delivered draft to the harness best-effort.
    signalEdit: vi.fn().mockResolvedValue({ ok: true }),
});

const createMockSummaryMetaRepository = () => ({
    create: vi.fn(),
    // TASK-355 Phase D — the sign-off assurance guard reads the draft's meta.
    // Default null = no harness assurance meta = guard is a no-op (legacy/manual
    // summaries sign through unchanged).
    findByContextItem: vi.fn().mockResolvedValue(null),
});

const createMockNamedEntityRepository = () => ({
    create: vi.fn(),
});

const createMockContextItemVersionRepository = () => ({
    create: vi.fn(),
    findById: vi.fn(),
    getVersionsByChangeReason: vi.fn().mockResolvedValue([]),
});

const createMockHttpService = () => ({
    axiosRef: {
        post: vi.fn(),
    },
});

const createMockConfigService = () => ({
    get: vi.fn().mockImplementation((key: string) => {
        if (key === 'SMR_URL') return 'http://localhost:8862';
        if (key === 'NLP_URL') return 'http://localhost:8864';
        return undefined;
    }),
});

const createMockPromptAssemblyService = () => ({
    assemble: vi.fn().mockImplementation((params: { transcript?: string }) => Promise.resolve({
        userPrompt: params.transcript ?? 'assembled prompt text',
        systemPrompt: '',
        hyperparameters: {},
        responseFormat: null,
        resolvedFrom: 'default',
    })),
});

// Helper to create mock context item
const createMockContextItem = (overrides: Partial<{
    id: string;
    tenantId: string;
    consultationId: string;
    type: string;
    content: string | null;
    isSummary: boolean;
    currentVersionNumber: number | null;
    updatedBy: string | null;
}> = {}) => ({
    id: overrides.id ?? 'ctx-item-123',
    tenantId: overrides.tenantId ?? 'tenant-1',
    consultationId: overrides.consultationId ?? 'consultation-1',
    type: overrides.type ?? 'RAW_SUMMARY',
    content: 'content' in overrides ? overrides.content : 'Patient John Doe diagnosed with Type 2 Diabetes. Prescribed Metformin 500mg.',
    isSummary: overrides.isSummary ?? true,
    currentVersionNumber: overrides.currentVersionNumber ?? null,
    updatedBy: overrides.updatedBy ?? null,
    toObject: vi.fn().mockReturnValue({}),
    changes: {},
});

// ============================================
// Test Suite
// ============================================

describe('SummaryService', () => {
    let service: SummaryService;
    let mockClsService: ReturnType<typeof createMockClsService>;
    let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
    let mockContextItemRepository: ReturnType<typeof createMockContextItemRepository>;
    let mockConsultationRepository: ReturnType<typeof createMockConsultationRepository>;
    let mockSummaryMetaRepository: ReturnType<typeof createMockSummaryMetaRepository>;
    let mockNamedEntityRepository: ReturnType<typeof createMockNamedEntityRepository>;
    let mockContextItemVersionRepository: ReturnType<typeof createMockContextItemVersionRepository>;
    let mockHttpService: ReturnType<typeof createMockHttpService>;
    let mockConfigService: ReturnType<typeof createMockConfigService>;
    let mockPromptAssemblyService: ReturnType<typeof createMockPromptAssemblyService>;
    // TASK-356 D-7 — the fail-closed SMR-selection seam every caller funnels through.
    let mockHarnessPolicyService: { resolveSmrSelection: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        vi.clearAllMocks();

        mockClsService = createMockClsService();
        mockEventEmitter = createMockEventEmitter();
        mockContextItemRepository = createMockContextItemRepository();
        mockConsultationRepository = createMockConsultationRepository();
        mockSummaryMetaRepository = createMockSummaryMetaRepository();
        mockNamedEntityRepository = createMockNamedEntityRepository();
        mockContextItemVersionRepository = createMockContextItemVersionRepository();
        mockHttpService = createMockHttpService();
        mockConfigService = createMockConfigService();
        mockPromptAssemblyService = createMockPromptAssemblyService();
        mockHarnessPolicyService = {
            resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'resolved-medgemma' }),
        };

        service = new SummaryService(
            mockContextItemRepository as any,
            mockConsultationRepository as any,
            mockSummaryMetaRepository as any,
            mockNamedEntityRepository as any,
            mockHttpService as any,
            mockConfigService as any,
            mockEventEmitter as any,
            mockClsService as any,
            mockContextItemVersionRepository as any,
            mockPromptAssemblyService as any,
            undefined, // secretsService (@Optional)
            undefined, // userProfileRepository (@Optional)
            undefined, // harnessAuditService (@Optional)
            undefined, // harnessGatewayService (@Optional)
            mockHarnessPolicyService as any, // TASK-356 D-7 — HarnessPolicyService resolver
        );
    });

    // ── TASK-356 D-7 (T-C1): callSmrService passes the cascade-resolved model ──
    describe('callSmrService SMR selection', () => {
        const primeGenerateMocks = () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'c-1', tenantId: 'tenant-1' });
            mockContextItemRepository.findTranscripts.mockResolvedValue([{ content: 'transcript text' }]);
            mockHttpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });
            mockContextItemRepository.create.mockResolvedValue({ id: 'ctx-new', content: 'S', createdAt: new Date(), updatedAt: new Date() });
            mockSummaryMetaRepository.create.mockResolvedValue({ id: 'meta-1' });
        };

        const lastSmrBody = () => {
            const call = mockHttpService.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/api/v1/generate'))!;
            return call[1] as { provider?: string; model?: string };
        };

        it('posts the cascade-resolved provider+model when the request omits a model', async () => {
            primeGenerateMocks();

            await service.generateSummary('c-1', { dnaStyleId: 'style-1' } as any);

            expect(mockHarnessPolicyService.resolveSmrSelection).toHaveBeenCalled();
            const body = lastSmrBody();
            expect(body.provider).toBe('lm-studio');
            expect(body.model).toBe('resolved-medgemma');
        });

        it('lets a caller-supplied model win over the resolved default', async () => {
            primeGenerateMocks();

            await service.generateSummary('c-1', { options: { model: 'caller-pinned' } } as any);

            const body = lastSmrBody();
            expect(body.model).toBe('caller-pinned');
        });
    });

    // ===========================================================================
    // extractEntities — Core Persistence Behavior (GAP-5)
    // ===========================================================================

    describe('extractEntities', () => {
        // ----- Successful persistence -----

        it('should persist entities returned by NLP service to NamedEntityRepository', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Patient with Diabetes' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'CONDITION', value: 'Diabetes', confidence: 0.95, start: 13, end: 21 },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockResolvedValue({ id: 'entity-1' });

            await service.extractEntities('ctx-item-123');

            expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(1);
            expect(mockNamedEntityRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    tenantId: 'tenant-1',
                    contextItemId: 'ctx-item-123',
                    text: 'Diabetes',
                    className: 'CONDITION',
                    confidence: 0.95,
                    startOffset: 13,
                    endOffset: 21,
                }),
            );
        });

        it('should persist multiple entities from NLP response', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Patient John Doe with Diabetes takes Metformin' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'PERSON', value: 'John Doe', confidence: 0.96, start: 8, end: 16 },
                        { type: 'CONDITION', value: 'Diabetes', confidence: 0.95, start: 22, end: 30 },
                        { type: 'MEDICATION', value: 'Metformin', confidence: 0.97, start: 37, end: 46 },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockResolvedValue({ id: 'entity-x' });

            await service.extractEntities('ctx-item-123');

            expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(3);
        });

        it('should call NLP service with correct content', async () => {
            const content = 'Specific medical content for NER extraction.';
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: [] },
            });

            await service.extractEntities('ctx-item-123');

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                expect.stringContaining('/classify/tokens'),
                { text: content },
            );
        });

        // ----- NLP response field mapping -----

        it('should map NLP response with value/type fields (primary naming)', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'MEDICATION', value: 'Aspirin', confidence: 0.97, start: 10, end: 17 },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockResolvedValue({ id: 'entity-1' });

            await service.extractEntities('ctx-item-123');

            expect(mockNamedEntityRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: 'Aspirin',
                    className: 'MEDICATION',
                    startOffset: 10,
                    endOffset: 17,
                }),
            );
        });

        it('should map NLP response with text/className fields (alternate naming)', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { className: 'PROCEDURE', text: 'MRI', confidence: 0.88, startOffset: 5, endOffset: 8 },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockResolvedValue({ id: 'entity-1' });

            await service.extractEntities('ctx-item-123');

            expect(mockNamedEntityRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: 'MRI',
                    className: 'PROCEDURE',
                    startOffset: 5,
                    endOffset: 8,
                }),
            );
        });

        // TASK-463 — the REAL NLP contract ({ text, entity_type, confidence,
        // position: { start, end } }; canonical apps/nlp/src/nlp/schemas/common.py).
        // Current code reads className via `type ?? className` and offsets via
        // `start ?? startOffset`, so both resolve undefined for the real shape and
        // persist blank/null — durable corruption. text survives via `?? entity.text`.
        it('should map the REAL NLP contract (entity_type + position) to className/offsets', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Take aspirin now' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { text: 'aspirin', entity_type: 'MEDICATION', confidence: 0.9, position: { start: 8, end: 15 } },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockResolvedValue({ id: 'entity-1' });

            await service.extractEntities('ctx-item-123');

            expect(mockNamedEntityRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: 'aspirin',
                    className: 'MEDICATION',
                    confidence: 0.9,
                    startOffset: 8,
                    endOffset: 15,
                }),
            );
        });

        // ----- Empty / no entities -----

        it('should not call repository.create when NLP returns empty entities', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Text with no entities' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: [] },
            });

            await service.extractEntities('ctx-item-123');

            expect(mockNamedEntityRepository.create).not.toHaveBeenCalled();
        });

        it('should not call repository.create when NLP returns undefined entities', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Some text' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: undefined },
            });

            await service.extractEntities('ctx-item-123');

            expect(mockNamedEntityRepository.create).not.toHaveBeenCalled();
        });

        // ----- Partial failure resilience -----

        it('should continue persisting remaining entities when one fails', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'PERSON', value: 'John', confidence: 0.9 },
                        { type: 'BAD_ENTITY', value: 'fail-me', confidence: 0.1 },
                        { type: 'MEDICATION', value: 'Aspirin', confidence: 0.95 },
                    ],
                },
            });

            mockNamedEntityRepository.create
                .mockResolvedValueOnce({ id: 'entity-1' })
                .mockRejectedValueOnce(new Error('Database constraint violation'))
                .mockResolvedValueOnce({ id: 'entity-3' });

            // Should NOT throw — partial failures are absorbed
            await service.extractEntities('ctx-item-123');

            expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(3);
        });

        // ----- SysEvent with savedCount -----

        it('should broadcast SysEvent with savedCount reflecting actual persisted entities', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ id: 'ctx-99', content: 'Test' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'CONDITION', value: 'Flu', confidence: 0.9 },
                        { type: 'MEDICATION', value: 'Tamiflu', confidence: 0.85 },
                    ],
                },
            });
            mockNamedEntityRepository.create
                .mockResolvedValueOnce({ id: 'entity-1' })
                .mockRejectedValueOnce(new Error('DB error'));

            await service.extractEntities('ctx-99');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'ctx-99',
                    data: expect.objectContaining({
                        entitiesExtracted: true,
                        entityCount: 2,
                        savedCount: 1,
                    }),
                }),
            );
        });

        it('should broadcast SysEvent with savedCount matching entityCount on full success', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ id: 'ctx-full', content: 'Content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'PERSON', value: 'Jane', confidence: 0.95 },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockResolvedValue({ id: 'entity-1' });

            await service.extractEntities('ctx-full');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'ctx-full',
                    data: expect.objectContaining({
                        entitiesExtracted: true,
                        entityCount: 1,
                        savedCount: 1,
                    }),
                }),
            );
        });

        // ----- Tenant validation -----

        it('should throw BadRequestException when tenant ID is not available', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                if (key === 'user') return { id: 'user-1' };
                return null;
            });

            // Even if context item exists, tenantId must be validated first
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Valid content' }),
            );

            await expect(
                service.extractEntities('ctx-item-123'),
            ).rejects.toThrow(BadRequestException);
        });

        // ----- Existing validation -----

        it('should throw NotFoundException when context item not found', async () => {
            mockContextItemRepository.findById.mockResolvedValue(null);

            await expect(
                service.extractEntities('non-existent'),
            ).rejects.toThrow(NotFoundException);
        });

        it('should throw BadRequestException when context item has no content', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: '' }),
            );

            await expect(
                service.extractEntities('ctx-empty'),
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw BadRequestException when context item content is only whitespace', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: '   \n\t  ' }),
            );

            await expect(
                service.extractEntities('ctx-ws'),
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw BadRequestException when NLP service call fails', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Valid content' }),
            );
            mockHttpService.axiosRef.post.mockRejectedValue(new Error('Connection refused'));

            await expect(
                service.extractEntities('ctx-item-123'),
            ).rejects.toThrow(BadRequestException);
        });

        // ----- Entities without optional fields -----

        it('should persist entities without confidence or position data', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'SYMPTOM', value: 'headache' },
                    ],
                },
            });
            mockNamedEntityRepository.create.mockResolvedValue({ id: 'entity-1' });

            await service.extractEntities('ctx-item-123');

            expect(mockNamedEntityRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: 'headache',
                    className: 'SYMPTOM',
                }),
            );
        });

        // ----- Realistic end-to-end -----

        it('should persist all entities from a realistic medical NER response', async () => {
            const medicalContent = 'Patient John Smith, 67yo male, presents with chest pain. ' +
                'History: hypertension, Type 2 Diabetes. Meds: Metoprolol 50mg, Metformin 1000mg.';

            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: medicalContent }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: {
                    entities: [
                        { type: 'PERSON', value: 'John Smith', confidence: 0.96, start: 8, end: 18 },
                        { type: 'AGE', value: '67yo', confidence: 0.94, start: 20, end: 24 },
                        { type: 'SYMPTOM', value: 'chest pain', confidence: 0.91, start: 47, end: 57 },
                        { type: 'CONDITION', value: 'hypertension', confidence: 0.97, start: 68, end: 80 },
                        { type: 'CONDITION', value: 'Type 2 Diabetes', confidence: 0.95, start: 82, end: 97 },
                        { type: 'MEDICATION', value: 'Metoprolol', confidence: 0.98, start: 104, end: 114 },
                        { type: 'DOSAGE', value: '50mg', confidence: 0.92, start: 115, end: 119 },
                        { type: 'MEDICATION', value: 'Metformin', confidence: 0.97, start: 121, end: 130 },
                        { type: 'DOSAGE', value: '1000mg', confidence: 0.93, start: 131, end: 137 },
                    ],
                },
            });

            let entityCounter = 0;
            mockNamedEntityRepository.create.mockImplementation(() => ({
                id: `entity-${++entityCounter}`,
            }));

            await service.extractEntities('ctx-item-123');

            expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(9);

            // Verify specific entities were persisted correctly
            expect(mockNamedEntityRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: 'Metoprolol',
                    className: 'MEDICATION',
                    confidence: 0.98,
                }),
            );
            expect(mockNamedEntityRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: 'hypertension',
                    className: 'CONDITION',
                }),
            );
        });
    });

    // ===========================================================================
    // GAP-8: NLP URL Path + Service URL Standardization
    // ===========================================================================

    describe('GAP-8: Service URL Configuration', () => {
        // ----- ConfigService integration (replaces process.env) -----

        it('should read SMR_URL from ConfigService', () => {
            expect(mockConfigService.get).toHaveBeenCalledWith('SMR_URL');
        });

        it('should read NLP_URL from ConfigService', () => {
            expect(mockConfigService.get).toHaveBeenCalledWith('NLP_URL');
        });

        it('should use ConfigService-provided SMR URL when calling SMR service', async () => {
            const customSmrUrl = 'http://smr-production:8862';
            const configWithCustomUrls = createMockConfigService();
            configWithCustomUrls.get.mockImplementation((key: string) => {
                if (key === 'SMR_URL') return customSmrUrl;
                if (key === 'NLP_URL') return 'http://nlp:8864';
                return undefined;
            });

            const serviceWithCustomUrl = new SummaryService(
                mockContextItemRepository as any,
                mockConsultationRepository as any,
                mockSummaryMetaRepository as any,
                mockNamedEntityRepository as any,
                mockHttpService as any,
                configWithCustomUrls as any,
                mockEventEmitter as any,
                mockClsService as any,
                mockContextItemVersionRepository as any,
                mockPromptAssemblyService as any,
            );

            mockConsultationRepository.findById.mockResolvedValue({ id: 'c-1', tenantId: 'tenant-1' });
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                { content: 'transcript text' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Generated summary', modelName: 'gpt-4o' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-new',
                content: 'Generated summary',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockSummaryMetaRepository.create.mockResolvedValue({ id: 'meta-1' });

            await serviceWithCustomUrl.generateSummary('c-1', {
                dnaStyleId: 'style-1',
            } as any);

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                `${customSmrUrl}/api/v1/generate`,
                expect.any(Object),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'X-Service-Token': expect.any(String),
                    }),
                }),
            );
        });

        it('should use ConfigService-provided NLP URL when calling NLP service', async () => {
            const customNlpUrl = 'http://nlp-production:8864';
            const configWithCustomUrls = createMockConfigService();
            configWithCustomUrls.get.mockImplementation((key: string) => {
                if (key === 'SMR_URL') return 'http://smr:8862';
                if (key === 'NLP_URL') return customNlpUrl;
                return undefined;
            });

            const serviceWithCustomUrl = new SummaryService(
                mockContextItemRepository as any,
                mockConsultationRepository as any,
                mockSummaryMetaRepository as any,
                mockNamedEntityRepository as any,
                mockHttpService as any,
                configWithCustomUrls as any,
                mockEventEmitter as any,
                mockClsService as any,
                mockContextItemVersionRepository as any,
                mockPromptAssemblyService as any,
            );

            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Patient data' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: [] },
            });

            await serviceWithCustomUrl.extractEntities('ctx-item-123');

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                `${customNlpUrl}/api/v1/classify/tokens`,
                { text: 'Patient data' },
            );
        });

        it('should call NLP service at /api/v1/classify/tokens (not /classify/tokens)', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test content' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: [] },
            });

            await service.extractEntities('ctx-item-123');

            const calledUrl = mockHttpService.axiosRef.post.mock.calls[0][0] as string;

            expect(calledUrl).toContain('/api/v1/classify/tokens');
            expect(calledUrl).not.toBe('http://localhost:8864/classify/tokens');
        });

        it('should use NLP URL path consistent with NerProcessor (/api/v1/classify/tokens)', async () => {
            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Medical text for NER' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: [{ type: 'CONDITION', value: 'Flu', confidence: 0.9 }] },
            });
            mockNamedEntityRepository.create.mockResolvedValue({ id: 'e-1' });

            await service.extractEntities('ctx-item-123');

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                'http://localhost:8864/api/v1/classify/tokens',
                expect.any(Object),
            );
        });

        it('should default SMR URL to http://localhost:8862 when ConfigService returns undefined', () => {
            const configWithNoUrls = {
                get: vi.fn().mockReturnValue(undefined),
            };

            const serviceWithDefaults = new SummaryService(
                mockContextItemRepository as any,
                mockConsultationRepository as any,
                mockSummaryMetaRepository as any,
                mockNamedEntityRepository as any,
                mockHttpService as any,
                configWithNoUrls as any,
                mockEventEmitter as any,
                mockClsService as any,
                mockContextItemVersionRepository as any,
                mockPromptAssemblyService as any,
            );

            mockConsultationRepository.findById.mockResolvedValue({ id: 'c-1', tenantId: 'tenant-1' });
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                { content: 'transcript' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'result', modelName: 'test' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-1',
                content: 'result',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockSummaryMetaRepository.create.mockResolvedValue({ id: 'meta-1' });

            return serviceWithDefaults
                .generateSummary('c-1', { dnaStyleId: 's' } as any)
                .then(() => {
                    const calledUrl = mockHttpService.axiosRef.post.mock.calls[0][0] as string;
                    expect(calledUrl).toBe('http://localhost:8862/api/v1/generate');
                    expect(calledUrl).not.toContain(':8003');
                });
        });

        it('should default NLP URL to http://localhost:8864 when ConfigService returns undefined', async () => {
            const configWithNoUrls = {
                get: vi.fn().mockReturnValue(undefined),
            };

            const serviceWithDefaults = new SummaryService(
                mockContextItemRepository as any,
                mockConsultationRepository as any,
                mockSummaryMetaRepository as any,
                mockNamedEntityRepository as any,
                mockHttpService as any,
                configWithNoUrls as any,
                mockEventEmitter as any,
                mockClsService as any,
                mockContextItemVersionRepository as any,
                mockPromptAssemblyService as any,
            );

            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { entities: [] },
            });

            await serviceWithDefaults.extractEntities('ctx-item-123');

            const calledUrl = mockHttpService.axiosRef.post.mock.calls[0][0] as string;
            expect(calledUrl).toBe('http://localhost:8864/api/v1/classify/tokens');
            expect(calledUrl).not.toContain(':8004');
        });

        it('should call SMR service at /api/v1/generate', async () => {
            mockConsultationRepository.findById.mockResolvedValue({ id: 'c-1', tenantId: 'tenant-1' });
            mockContextItemRepository.findCaseNotes.mockResolvedValue([
                { content: 'Historical case note content' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'Pre-summary result', modelName: 'gpt-4o' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-presummary',
                content: 'Pre-summary result',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockSummaryMetaRepository.create.mockResolvedValue({ id: 'meta-1' });

            await service.generatePreSummary('c-1', {
                dnaStyleId: 'style-1',
            } as any);

            expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
                'http://localhost:8862/api/v1/generate',
                expect.any(Object),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'X-Service-Token': expect.any(String),
                    }),
                }),
            );
        });

        it('should use same default NLP port (8864) as NerProcessor', () => {
            const configWithNoUrls = { get: vi.fn().mockReturnValue(undefined) };

            const serviceWithDefaults = new SummaryService(
                mockContextItemRepository as any,
                mockConsultationRepository as any,
                mockSummaryMetaRepository as any,
                mockNamedEntityRepository as any,
                mockHttpService as any,
                configWithNoUrls as any,
                mockEventEmitter as any,
                mockClsService as any,
                mockContextItemVersionRepository as any,
                mockPromptAssemblyService as any,
            );

            mockContextItemRepository.findById.mockResolvedValue(
                createMockContextItem({ content: 'Test' }),
            );
            mockHttpService.axiosRef.post.mockResolvedValue({ data: { entities: [] } });

            return serviceWithDefaults.extractEntities('ctx-item-123').then(() => {
                const calledUrl = mockHttpService.axiosRef.post.mock.calls[0][0] as string;
                expect(calledUrl).toMatch(/^http:\/\/localhost:8864\//);
            });
        });

        it('should use same default SMR port (8862) as SummaryProcessor', () => {
            const configWithNoUrls = { get: vi.fn().mockReturnValue(undefined) };

            const serviceWithDefaults = new SummaryService(
                mockContextItemRepository as any,
                mockConsultationRepository as any,
                mockSummaryMetaRepository as any,
                mockNamedEntityRepository as any,
                mockHttpService as any,
                configWithNoUrls as any,
                mockEventEmitter as any,
                mockClsService as any,
                mockContextItemVersionRepository as any,
                mockPromptAssemblyService as any,
            );

            mockConsultationRepository.findById.mockResolvedValue({ id: 'c-1', tenantId: 'tenant-1' });
            mockContextItemRepository.findTranscripts.mockResolvedValue([
                { content: 'transcript' },
            ]);
            mockHttpService.axiosRef.post.mockResolvedValue({
                data: { summary: 'result', modelName: 'test' },
            });
            mockContextItemRepository.create.mockResolvedValue({
                id: 'ctx-1',
                content: 'result',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            mockSummaryMetaRepository.create.mockResolvedValue({ id: 'meta-1' });

            return serviceWithDefaults
                .generateSummary('c-1', { dnaStyleId: 's' } as any)
                .then(() => {
                    const calledUrl = mockHttpService.axiosRef.post.mock.calls[0][0] as string;
                    expect(calledUrl).toMatch(/^http:\/\/localhost:8862\//);
                });
        });
    });

    // ===========================================================================
    // updateSummary — ContextItemVersion Creation (WS-3 Task 2)
    // ===========================================================================

    describe('updateSummary', () => {
        const mockedFactory = vi.mocked(ContextItemVersionFactory);

        it('should create ContextItemVersion before updating content', async () => {
            const mockItem = createMockContextItem({
                id: 'ctx-summary-1',
                content: 'Original summary content',
                currentVersionNumber: 0,
            });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'version-id-1' });
            mockContextItemRepository.update.mockResolvedValue({
                ...mockItem,
                content: 'Updated content',
                currentVersionNumber: 1,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            await service.updateSummary('ctx-summary-1', { content: 'Updated content' });

            expect(mockContextItemVersionRepository.create).toHaveBeenCalledTimes(1);
            expect(mockedFactory.CreateFromContextItem).toHaveBeenCalledWith(
                mockItem,
                1,
                'Manual edit',
                'user-1',
                'doctor_edit',
                undefined,
            );
        });

        // TASK-329 (P6) — editing must bump currentVersionNumber on the persisted item (no in-place overwrite)
        it('should persist the bumped currentVersionNumber on the edited summary', async () => {
            const mockItem = createMockContextItem({
                id: 'ctx-bump-329',
                content: 'Original',
                currentVersionNumber: 2,
            });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-3' });
            mockContextItemRepository.update.mockImplementation((_id: string, item: { currentVersionNumber?: number }) => Promise.resolve({
                ...item,
                createdAt: new Date(),
                updatedAt: new Date(),
            }));

            await service.updateSummary('ctx-bump-329', { content: 'Edited content' });

            expect(mockedFactory.CreateFromContextItem).toHaveBeenCalledWith(mockItem, 3, 'Manual edit', 'user-1', 'doctor_edit', undefined);
            expect(mockContextItemRepository.update).toHaveBeenCalledWith(
                'ctx-bump-329',
                expect.objectContaining({ currentVersionNumber: 3 }),
            );
        });

        it('should use changeReason from request when provided', async () => {
            const mockItem = createMockContextItem({ id: 'ctx-s-2', content: 'Old content' });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-1' });
            mockContextItemRepository.update.mockResolvedValue({
                ...mockItem,
                content: 'New content',
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            await service.updateSummary('ctx-s-2', {
                content: 'New content',
                changeReason: 'Corrected diagnosis',
                changeSource: 'doctor_edit',
                changeSummary: 'Fixed typo in diagnosis section',
            });

            expect(mockedFactory.CreateFromContextItem).toHaveBeenCalledWith(
                mockItem,
                1,
                'Corrected diagnosis',
                'user-1',
                'doctor_edit',
                'Fixed typo in diagnosis section',
            );
        });

        it('should use default changeReason when not provided', async () => {
            const mockItem = createMockContextItem({ id: 'ctx-s-3', content: 'Content' });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-1' });
            mockContextItemRepository.update.mockResolvedValue({
                ...mockItem,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            await service.updateSummary('ctx-s-3', { content: 'New' });

            expect(mockedFactory.CreateFromContextItem).toHaveBeenCalledWith(
                expect.anything(),
                expect.any(Number),
                'Manual edit',
                expect.any(String),
                'doctor_edit',
                undefined,
            );
        });

        it('should increment versionNumber from current value', async () => {
            const mockItem = createMockContextItem({
                id: 'ctx-s-4',
                content: 'V3 content',
                currentVersionNumber: 3,
            });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-4' });
            mockContextItemRepository.update.mockResolvedValue({
                ...mockItem,
                currentVersionNumber: 4,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            await service.updateSummary('ctx-s-4', { content: 'V4 content' });

            expect(mockedFactory.CreateFromContextItem).toHaveBeenCalledWith(
                expect.anything(),
                4,
                expect.any(String),
                expect.any(String),
                expect.any(String),
                undefined,
            );
        });

        it('should snapshot previous content not new content', async () => {
            const originalContent = 'This is the original summary before edit';
            const mockItem = createMockContextItem({
                id: 'ctx-s-5',
                content: originalContent,
            });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-1' });
            mockContextItemRepository.update.mockResolvedValue({
                ...mockItem,
                content: 'Completely new content',
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            await service.updateSummary('ctx-s-5', { content: 'Completely new content' });

            expect(mockedFactory.CreateFromContextItem).toHaveBeenCalledTimes(1);
            const versionEntity = mockContextItemVersionRepository.create.mock.calls[0][0];
            expect(versionEntity.content).toBe(originalContent);
        });

        it('should still update content after versioning', async () => {
            const mockItem = createMockContextItem({ id: 'ctx-s-6', content: 'Old' });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-1' });
            mockContextItemRepository.update.mockResolvedValue({
                ...mockItem,
                content: 'New content here',
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            const result = await service.updateSummary('ctx-s-6', { content: 'New content here' });

            expect(mockContextItemRepository.update).toHaveBeenCalledTimes(1);
            expect(result).toBeDefined();
        });

        it('should throw NotFoundException when context item not found', async () => {
            mockContextItemRepository.findById.mockResolvedValue(null);

            await expect(
                service.updateSummary('non-existent', { content: 'test' }),
            ).rejects.toThrow(NotFoundException);

            expect(mockContextItemVersionRepository.create).not.toHaveBeenCalled();
        });

        it('should throw BadRequestException for non-summary items', async () => {
            const mockItem = createMockContextItem({
                id: 'ctx-transcript',
                isSummary: false,
            });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);

            await expect(
                service.updateSummary('ctx-transcript', { content: 'test' }),
            ).rejects.toThrow(BadRequestException);

            expect(mockContextItemVersionRepository.create).not.toHaveBeenCalled();
        });

        it('should handle null versionNumber by starting at 1', async () => {
            const mockItem = createMockContextItem({
                id: 'ctx-null-ver',
                content: 'Content',
                currentVersionNumber: null,
            });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-1' });
            mockContextItemRepository.update.mockResolvedValue({
                ...mockItem,
                currentVersionNumber: 1,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            await service.updateSummary('ctx-null-ver', { content: 'New' });

            expect(mockedFactory.CreateFromContextItem).toHaveBeenCalledWith(
                expect.anything(),
                1,
                expect.any(String),
                expect.any(String),
                expect.any(String),
                undefined,
            );
        });

        it('should use "system" as changedBy when requestUserId is null', async () => {
            const clsWithNoUser = createMockClsService();
            clsWithNoUser.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return 'tenant-1';
                if (key === 'user') return null;
                return null;
            });

            const serviceNoUser = new SummaryService(
                mockContextItemRepository as any,
                mockConsultationRepository as any,
                mockSummaryMetaRepository as any,
                mockNamedEntityRepository as any,
                mockHttpService as any,
                mockConfigService as any,
                mockEventEmitter as any,
                clsWithNoUser as any,
                mockContextItemVersionRepository as any,
                mockPromptAssemblyService as any,
            );

            const mockItem = createMockContextItem({ id: 'ctx-no-user', content: 'Content' });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-1' });
            mockContextItemRepository.update.mockResolvedValue({
                ...mockItem,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            await serviceNoUser.updateSummary('ctx-no-user', { content: 'Edited' });

            expect(mockedFactory.CreateFromContextItem).toHaveBeenCalledWith(
                expect.anything(),
                expect.any(Number),
                expect.any(String),
                'system',
                expect.any(String),
                undefined,
            );
        });

        it('should not update updatedBy when requestUserId is null', async () => {
            const clsWithNoUser = createMockClsService();
            clsWithNoUser.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return 'tenant-1';
                if (key === 'user') return null;
                return null;
            });

            const serviceNoUser = new SummaryService(
                mockContextItemRepository as any,
                mockConsultationRepository as any,
                mockSummaryMetaRepository as any,
                mockNamedEntityRepository as any,
                mockHttpService as any,
                mockConfigService as any,
                mockEventEmitter as any,
                clsWithNoUser as any,
                mockContextItemVersionRepository as any,
                mockPromptAssemblyService as any,
            );

            const mockItem = createMockContextItem({
                id: 'ctx-no-user-2',
                content: 'Content',
                updatedBy: null,
            });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-1' });
            mockContextItemRepository.update.mockResolvedValue({
                ...mockItem,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            await serviceNoUser.updateSummary('ctx-no-user-2', { content: 'Edited' });

            expect(mockItem.updatedBy).toBeNull();
        });

        it('should not modify content when request.content is undefined', async () => {
            const mockItem = createMockContextItem({
                id: 'ctx-meta-only',
                content: 'Original stays',
            });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-1' });
            mockContextItemRepository.update.mockResolvedValue({
                ...mockItem,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            await service.updateSummary('ctx-meta-only', {
                changeReason: 'Metadata update only',
                changeSource: 'system',
            });

            expect(mockItem.content).toBe('Original stays');
            expect(mockContextItemRepository.update).toHaveBeenCalledTimes(1);
        });

        it('should propagate error when version repository create fails', async () => {
            const mockItem = createMockContextItem({ id: 'ctx-ver-fail', content: 'Content' });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockRejectedValue(
                new Error('Database constraint violation'),
            );

            await expect(
                service.updateSummary('ctx-ver-fail', { content: 'New' }),
            ).rejects.toThrow('Database constraint violation');

            expect(mockContextItemRepository.update).not.toHaveBeenCalled();
        });

        it('should broadcast SysEvent with correct payload after update', async () => {
            const mockItem = createMockContextItem({ id: 'ctx-event', content: 'Old' });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-1' });
            mockContextItemRepository.update.mockResolvedValue({
                id: 'ctx-event',
                content: 'New',
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            await service.updateSummary('ctx-event', { content: 'New' });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'ctx-event',
                }),
            );
        });

        it('should return mapped SummaryResponse from updated entity', async () => {
            const now = new Date();
            const mockItem = createMockContextItem({ id: 'ctx-resp', content: 'Old' });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-1' });
            mockContextItemRepository.update.mockResolvedValue({
                id: 'ctx-resp',
                consultationId: 'consultation-1',
                type: 'RAW_SUMMARY',
                content: 'Updated content',
                createdAt: now,
                updatedAt: now,
            });

            const result = await service.updateSummary('ctx-resp', { content: 'Updated content' });

            expect(result).toEqual(expect.objectContaining({
                id: 'ctx-resp',
                consultationId: 'consultation-1',
                type: 'RAW_SUMMARY',
                content: 'Updated content',
            }));
            expect(result.createdAt).toBeDefined();
            expect(result.updatedAt).toBeDefined();
        });

        it('should use "ai_regeneration" changeSource when provided', async () => {
            const mockItem = createMockContextItem({ id: 'ctx-ai', content: 'AI old' });
            mockContextItemRepository.findById.mockResolvedValue(mockItem);
            mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-1' });
            mockContextItemRepository.update.mockResolvedValue({
                ...mockItem,
                content: 'AI new',
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            await service.updateSummary('ctx-ai', {
                content: 'AI new',
                changeSource: 'ai_regeneration',
                changeReason: 'AI regenerated summary',
            });

            expect(mockedFactory.CreateFromContextItem).toHaveBeenCalledWith(
                expect.anything(),
                expect.any(Number),
                'AI regenerated summary',
                'user-1',
                'ai_regeneration',
                undefined,
            );
        });
    });

    // ============================================================
    // TASK-305 D.4 — Cross-aggregate tenant isolation for SummaryService
    //
    // The summary pipeline takes either `consultationId` (generate*) or
    // `contextItemId` (update/approve/extract) — both reference aggregates
    // that may be tenant-scoped to a foreign tenant. Audit C-1 / C-3 / M-7.
    //
    // All cross-aggregate checks throw `NotFoundException` (no existence
    // leak); legitimate misses produce the same error shape as cross-tenant
    // probes.
    // ============================================================
    describe('TASK-305 D.4 — cross-aggregate tenant checks', () => {
        describe('generatePreSummary', () => {
            it('throws NotFoundException when parent consultation belongs to another tenant', async () => {
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'c-other',
                    tenantId: 'tenant-OTHER',
                });

                await expect(
                    service.generatePreSummary('c-other', {} as any),
                ).rejects.toThrow(NotFoundException);
                expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
                expect(mockContextItemRepository.create).not.toHaveBeenCalled();
            });
        });

        describe('generateSummary', () => {
            it('throws NotFoundException when parent consultation belongs to another tenant', async () => {
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'c-other',
                    tenantId: 'tenant-OTHER',
                });

                await expect(
                    service.generateSummary('c-other', { transcription: 'x' } as any),
                ).rejects.toThrow(NotFoundException);
                expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
                expect(mockContextItemRepository.create).not.toHaveBeenCalled();
            });
        });

        describe('updateSummary', () => {
            it('throws NotFoundException when target context item belongs to another tenant', async () => {
                mockContextItemRepository.findById.mockResolvedValue(
                    createMockContextItem({
                        id: 'ctx-other',
                        tenantId: 'tenant-OTHER',
                        isSummary: true,
                    }),
                );

                await expect(
                    service.updateSummary('ctx-other', { content: 'tampered' } as any),
                ).rejects.toThrow(NotFoundException);
                expect(mockContextItemRepository.update).not.toHaveBeenCalled();
            });
        });

        describe('approveSummary', () => {
            it('throws NotFoundException when target context item belongs to another tenant', async () => {
                mockContextItemRepository.findById.mockResolvedValue(
                    createMockContextItem({
                        id: 'ctx-other',
                        tenantId: 'tenant-OTHER',
                        isFinalSummary: true,
                    }),
                );

                await expect(
                    service.approveSummary('ctx-other'),
                ).rejects.toThrow(NotFoundException);
                expect(mockContextItemRepository.update).not.toHaveBeenCalled();
            });
        });

        // ===================================================================
        // TASK-330 Phase 1 — attestation gate (confirm-before-commit)
        //
        // approveSummary MUST, in one path that cannot be bypassed:
        //   1. write a SIGNED_NOTE ContextItemVersion carrying attestation fields,
        //   2. append an ATTEST HarnessAuditEvent (Phase-0 WORM trail),
        //   3. flip Consultation.status → SIGNED.
        // ===================================================================
        describe('approveSummary — attestation gate (TASK-330 Phase 1)', () => {
            let mockHarnessAuditService: ReturnType<typeof createMockHarnessAuditService>;
            let gatedService: SummaryService;

            const makeFinalSummary = () => ({
                id: 'ctx-item-123',
                tenantId: 'tenant-1',
                consultationId: 'consultation-1',
                type: 'RAW_SUMMARY',
                content: 'S: ... O: ... A: ... P: ...',
                isFinalSummary: true,
                isSummary: true,
                currentVersionNumber: 2,
                updatedBy: null as string | null,
                toObject: vi.fn().mockReturnValue({}),
                changes: {},
            });

            beforeEach(() => {
                mockHarnessAuditService = createMockHarnessAuditService();
                gatedService = new SummaryService(
                    mockContextItemRepository as any,
                    mockConsultationRepository as any,
                    mockSummaryMetaRepository as any,
                    mockNamedEntityRepository as any,
                    mockHttpService as any,
                    mockConfigService as any,
                    mockEventEmitter as any,
                    mockClsService as any,
                    mockContextItemVersionRepository as any,
                    mockPromptAssemblyService as any,
                    undefined, // secretsService
                    undefined, // userProfileRepository
                    mockHarnessAuditService as any, // harnessAuditService (Phase-0 WORM)
                );
            });

            it('writes an attested SIGNED_NOTE version, appends an ATTEST WORM event, and sets status=SIGNED', async () => {
                mockContextItemRepository.findById.mockResolvedValue(makeFinalSummary());
                mockContextItemVersionRepository.getVersionsByChangeReason.mockResolvedValue([]);
                mockContextItemVersionRepository.create.mockResolvedValue({ id: 'signed-version-id-1' });
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-1',
                    tenantId: 'tenant-1',
                    status: ConsultationStatus.OPEN,
                    updatedBy: null,
                });
                mockConsultationRepository.update.mockResolvedValue({ id: 'consultation-1' });

                const result = await gatedService.approveSummary('ctx-item-123');

                // 1. attested SIGNED_NOTE version
                expect(ContextItemVersionFactory.CreateSignedNoteVersion).toHaveBeenCalledWith(
                    expect.objectContaining({
                        contextItemId: 'ctx-item-123',
                        tenantId: 'tenant-1',
                        attestedBy: 'user-1',
                        attestationHash: expect.any(String),
                    }),
                );
                expect(mockContextItemVersionRepository.create).toHaveBeenCalledTimes(1);

                // 2. ATTEST WORM audit event referencing the signed version
                expect(mockHarnessAuditService.append).toHaveBeenCalledTimes(1);
                expect(mockHarnessAuditService.append).toHaveBeenCalledWith(
                    expect.objectContaining({
                        tenantId: 'tenant-1',
                        consultationId: 'consultation-1',
                        action: HarnessAuditAction.ATTEST,
                        clinicianId: 'user-1',
                        contextItemVersionId: 'signed-version-id-1',
                        attestationHash: expect.any(String),
                    }),
                );

                // 3. consultation lifecycle → SIGNED
                expect(mockConsultationRepository.update).toHaveBeenCalledWith(
                    'consultation-1',
                    expect.objectContaining({ status: ConsultationStatus.SIGNED }),
                );

                expect(result.approvalStatus).toBe('APPROVED');
                expect(result.approvedBy).toBe('user-1');
            });

            it('is idempotent — an already-approved summary does NOT re-attest, re-audit, or re-sign', async () => {
                mockContextItemRepository.findById.mockResolvedValue(makeFinalSummary());
                mockContextItemVersionRepository.getVersionsByChangeReason.mockResolvedValue([
                    { changedBy: 'user-9', createdAt: new Date('2026-06-01T00:00:00.000Z') },
                ]);

                const result = await gatedService.approveSummary('ctx-item-123');

                expect(ContextItemVersionFactory.CreateSignedNoteVersion).not.toHaveBeenCalled();
                expect(mockHarnessAuditService.append).not.toHaveBeenCalled();
                expect(mockConsultationRepository.update).not.toHaveBeenCalled();
                expect(result.approvalStatus).toBe('APPROVED');
                expect(result.approvedBy).toBe('user-9');
            });

            it('is fail-closed — if the WORM audit append fails, approval is rejected (gate cannot be bypassed)', async () => {
                mockContextItemRepository.findById.mockResolvedValue(makeFinalSummary());
                mockContextItemVersionRepository.getVersionsByChangeReason.mockResolvedValue([]);
                mockContextItemVersionRepository.create.mockResolvedValue({ id: 'signed-version-id-1' });
                mockHarnessAuditService.append.mockRejectedValue(new Error('audit chain unavailable'));

                await expect(gatedService.approveSummary('ctx-item-123')).rejects.toThrow();

                // The consultation must NOT be flipped to SIGNED when the audit fails.
                expect(mockConsultationRepository.update).not.toHaveBeenCalled();
            });
        });

        // ===================================================================
        // TASK-355 Phase D — RELAXED sign-off governance (Slice 5b)
        //
        // Clinician-autonomy + full-audit model (doc 08 §7.1):
        //   Q2a — signing BEFORE assurance completes is allowed with NO ack; the
        //         sign proceeds and a SIGNED_BEFORE_ASSURANCE WORM annotation is
        //         appended so the late-verdict path can correlate.
        //   Q4  — signing PAST a completed safety FLAG is allowed only via an
        //         explicit one-click override flag (`overrideSafetyFlag`), recorded
        //         as a SAFETY_OVERRIDE WORM event (no free-text). Without the flag
        //         a safety FLAG still hard-blocks.
        // Legacy/non-harness summaries (no meta) and clean assured drafts (no
        // safety FLAG) sign through unchanged, with NO extra annotations.
        // ===================================================================
        describe('approveSummary — Phase D assurance guard (TASK-355)', () => {
            let mockHarnessAuditService: ReturnType<typeof createMockHarnessAuditService>;
            let gatedService: SummaryService;

            const makeFinalSummary = () => ({
                id: 'ctx-item-123',
                tenantId: 'tenant-1',
                consultationId: 'consultation-1',
                type: 'RAW_SUMMARY',
                content: 'S: ... O: ... A: ... P: ...',
                isFinalSummary: true,
                isSummary: true,
                currentVersionNumber: 2,
                updatedBy: null as string | null,
                toObject: vi.fn().mockReturnValue({}),
                changes: {},
            });

            beforeEach(() => {
                mockHarnessAuditService = createMockHarnessAuditService();
                gatedService = new SummaryService(
                    mockContextItemRepository as any,
                    mockConsultationRepository as any,
                    mockSummaryMetaRepository as any,
                    mockNamedEntityRepository as any,
                    mockHttpService as any,
                    mockConfigService as any,
                    mockEventEmitter as any,
                    mockClsService as any,
                    mockContextItemVersionRepository as any,
                    mockPromptAssemblyService as any,
                    undefined, // secretsService
                    undefined, // userProfileRepository
                    mockHarnessAuditService as any,
                );
                mockContextItemRepository.findById.mockResolvedValue(makeFinalSummary());
                mockContextItemVersionRepository.getVersionsByChangeReason.mockResolvedValue([]);
                mockContextItemVersionRepository.create.mockResolvedValue({ id: 'signed-version-id-1' });
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-1',
                    tenantId: 'tenant-1',
                    status: ConsultationStatus.PENDING_REVIEW,
                    updatedBy: null,
                });
                mockConsultationRepository.update.mockResolvedValue({ id: 'consultation-1' });
            });

            it('Q2a — ALLOWS sign-off while assurance is pending (no ack) and records a SIGNED_BEFORE_ASSURANCE annotation', async () => {
                mockSummaryMetaRepository.findByContextItem.mockResolvedValue({
                    id: 'sm-1',
                    assuranceCompletedAt: null,
                    guardrailDecisions: null,
                });

                const result = await gatedService.approveSummary('ctx-item-123');

                // The note IS signed (clinician autonomy) — Q2a is frictionless.
                expect(result.approvalStatus).toBe('APPROVED');
                expect(ContextItemVersionFactory.CreateSignedNoteVersion).toHaveBeenCalledTimes(1);
                expect(mockConsultationRepository.update).toHaveBeenCalledWith(
                    'consultation-1',
                    expect.objectContaining({ status: ConsultationStatus.SIGNED }),
                );
                // …but the WORM trail records BOTH the attestation AND that the sign
                // preceded assurance, so the late-verdict path can correlate.
                const actions = mockHarnessAuditService.append.mock.calls.map((c: any[]) => c[0].action);
                expect(actions).toContain(HarnessAuditAction.ATTEST);
                expect(actions).toContain(HarnessAuditAction.SIGNED_BEFORE_ASSURANCE);
                expect(actions).not.toContain(HarnessAuditAction.SAFETY_OVERRIDE);
            });

            it('Q4 — HARD-REJECTS sign-off past a safety FLAG WITHOUT the override flag (object shape)', async () => {
                mockSummaryMetaRepository.findByContextItem.mockResolvedValue({
                    id: 'sm-1',
                    assuranceCompletedAt: new Date(),
                    guardrailDecisions: { safety: { decision: 'FLAG' } },
                });

                await expect(gatedService.approveSummary('ctx-item-123')).rejects.toThrow(ConflictException);
                expect(ContextItemVersionFactory.CreateSignedNoteVersion).not.toHaveBeenCalled();
                expect(mockHarnessAuditService.append).not.toHaveBeenCalled();
            });

            it('Q4 — HARD-REJECTS sign-off past a safety FLAG WITHOUT the override flag (string shape)', async () => {
                mockSummaryMetaRepository.findByContextItem.mockResolvedValue({
                    id: 'sm-1',
                    assuranceCompletedAt: new Date(),
                    guardrailDecisions: { safety: 'FLAG' },
                });

                await expect(gatedService.approveSummary('ctx-item-123')).rejects.toThrow(ConflictException);
            });

            it('Q4 — ALLOWS sign-off past a completed safety FLAG via one-click override + records a SAFETY_OVERRIDE WORM event', async () => {
                mockSummaryMetaRepository.findByContextItem.mockResolvedValue({
                    id: 'sm-1',
                    assuranceCompletedAt: new Date(),
                    guardrailDecisions: { safety: { decision: 'FLAG' } },
                    gateDecision: 'FLAG',
                });

                const result = await gatedService.approveSummary('ctx-item-123', { overrideSafetyFlag: true });

                expect(result.approvalStatus).toBe('APPROVED');
                expect(ContextItemVersionFactory.CreateSignedNoteVersion).toHaveBeenCalledTimes(1);
                expect(mockConsultationRepository.update).toHaveBeenCalledWith(
                    'consultation-1',
                    expect.objectContaining({ status: ConsultationStatus.SIGNED }),
                );
                const actions = mockHarnessAuditService.append.mock.calls.map((c: any[]) => c[0].action);
                expect(actions).toContain(HarnessAuditAction.SAFETY_OVERRIDE);
                expect(actions).toContain(HarnessAuditAction.ATTEST);
                // A completed safety FLAG means assurance landed, so this is NOT a
                // before-assurance sign — no SIGNED_BEFORE_ASSURANCE annotation.
                expect(actions).not.toContain(HarnessAuditAction.SIGNED_BEFORE_ASSURANCE);
            });

            it('Q4 — the SAFETY_OVERRIDE WORM append is FAIL-CLOSED (override audit failure rejects the sign)', async () => {
                mockSummaryMetaRepository.findByContextItem.mockResolvedValue({
                    id: 'sm-1',
                    assuranceCompletedAt: new Date(),
                    guardrailDecisions: { safety: { decision: 'FLAG' } },
                });
                // Fail the very first audit append (the SAFETY_OVERRIDE event).
                mockHarnessAuditService.append.mockRejectedValueOnce(new Error('audit chain unavailable'));

                await expect(
                    gatedService.approveSummary('ctx-item-123', { overrideSafetyFlag: true }),
                ).rejects.toThrow();
                // The consultation must NOT be flipped to SIGNED when the override audit fails.
                expect(mockConsultationRepository.update).not.toHaveBeenCalled();
            });

            it('ALLOWS sign-off when assured and safety is not FLAG (a groundedness FLAG alone does NOT block, no extra annotations)', async () => {
                mockSummaryMetaRepository.findByContextItem.mockResolvedValue({
                    id: 'sm-1',
                    assuranceCompletedAt: new Date(),
                    guardrailDecisions: { safety: { verdict: 'pass' }, groundedness: { decision: 'FLAG' } },
                });

                const result = await gatedService.approveSummary('ctx-item-123');

                expect(result.approvalStatus).toBe('APPROVED');
                expect(ContextItemVersionFactory.CreateSignedNoteVersion).toHaveBeenCalledTimes(1);
                expect(mockConsultationRepository.update).toHaveBeenCalledWith(
                    'consultation-1',
                    expect.objectContaining({ status: ConsultationStatus.SIGNED }),
                );
                const actions = mockHarnessAuditService.append.mock.calls.map((c: any[]) => c[0].action);
                expect(actions).not.toContain(HarnessAuditAction.SAFETY_OVERRIDE);
                expect(actions).not.toContain(HarnessAuditAction.SIGNED_BEFORE_ASSURANCE);
            });

            it('ALLOWS sign-off for legacy/non-harness summaries that have no SummaryMeta', async () => {
                mockSummaryMetaRepository.findByContextItem.mockResolvedValue(null);

                const result = await gatedService.approveSummary('ctx-item-123');

                expect(result.approvalStatus).toBe('APPROVED');
                expect(ContextItemVersionFactory.CreateSignedNoteVersion).toHaveBeenCalledTimes(1);
            });
        });

        // ===================================================================
        // TASK-330 Phase 1 (Lane G) — best-effort harness sign-off signal
        //
        // AFTER the SIGNED_NOTE + ATTEST + status=SIGNED writes (the WORM trail
        // is the source of truth), approveSummary forwards the sign-off to the
        // harness so it can resolve the workflow's approval wait-condition. A
        // signal failure MUST NOT block or roll back the sign-off.
        // ===================================================================
        describe('approveSummary — harness sign-off signal (TASK-330 Lane G)', () => {
            let mockHarnessAuditService: ReturnType<typeof createMockHarnessAuditService>;
            let mockHarnessGateway: ReturnType<typeof createMockHarnessGatewayService>;
            let signalingService: SummaryService;

            const makeFinalSummary = () => ({
                id: 'ctx-item-123',
                tenantId: 'tenant-1',
                consultationId: 'consultation-1',
                type: 'RAW_SUMMARY',
                content: 'S: ... O: ... A: ... P: ...',
                isFinalSummary: true,
                isSummary: true,
                currentVersionNumber: 2,
                updatedBy: null as string | null,
                toObject: vi.fn().mockReturnValue({}),
                changes: {},
            });

            beforeEach(() => {
                mockHarnessAuditService = createMockHarnessAuditService();
                mockHarnessGateway = createMockHarnessGatewayService();
                signalingService = new SummaryService(
                    mockContextItemRepository as any,
                    mockConsultationRepository as any,
                    mockSummaryMetaRepository as any,
                    mockNamedEntityRepository as any,
                    mockHttpService as any,
                    mockConfigService as any,
                    mockEventEmitter as any,
                    mockClsService as any,
                    mockContextItemVersionRepository as any,
                    mockPromptAssemblyService as any,
                    undefined, // secretsService
                    undefined, // userProfileRepository
                    mockHarnessAuditService as any, // harnessAuditService (Phase-0 WORM)
                    mockHarnessGateway as any, // harnessGatewayService (Lane G)
                );

                mockContextItemRepository.findById.mockResolvedValue(makeFinalSummary());
                mockContextItemVersionRepository.getVersionsByChangeReason.mockResolvedValue([]);
                mockContextItemVersionRepository.create.mockResolvedValue({ id: 'signed-version-id-1' });
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-1',
                    tenantId: 'tenant-1',
                    status: ConsultationStatus.OPEN,
                    updatedBy: null,
                });
                mockConsultationRepository.update.mockResolvedValue({ id: 'consultation-1' });
            });

            it('signals the harness with versionId + attestationHash + clinicianId after a successful sign-off', async () => {
                await signalingService.approveSummary('ctx-item-123');

                expect(mockHarnessGateway.signalApproval).toHaveBeenCalledTimes(1);
                expect(mockHarnessGateway.signalApproval).toHaveBeenCalledWith(
                    'consultation-1',
                    expect.objectContaining({
                        tenantId: 'tenant-1',
                        contextItemVersionId: 'signed-version-id-1',
                        attestationHash: expect.any(String),
                        clinicianId: 'user-1',
                    }),
                );
            });

            it('signals AFTER the consultation is flipped to SIGNED (WORM is the source of truth)', async () => {
                const order: string[] = [];
                mockConsultationRepository.update.mockImplementation(async () => {
                    order.push('status-signed');
                    return { id: 'consultation-1' };
                });
                mockHarnessGateway.signalApproval.mockImplementation(async () => {
                    order.push('harness-signal');
                    return { ok: true };
                });

                await signalingService.approveSummary('ctx-item-123');

                expect(order).toEqual(['status-signed', 'harness-signal']);
            });

            it('still completes the sign-off when the harness signal throws (best-effort, not rolled back)', async () => {
                mockHarnessGateway.signalApproval.mockRejectedValue(new Error('harness unreachable'));

                const result = await signalingService.approveSummary('ctx-item-123');

                expect(result.approvalStatus).toBe('APPROVED');
                expect(mockConsultationRepository.update).toHaveBeenCalledWith(
                    'consultation-1',
                    expect.objectContaining({ status: ConsultationStatus.SIGNED }),
                );
            });

            it('does not signal on the idempotent already-approved path', async () => {
                mockContextItemVersionRepository.getVersionsByChangeReason.mockResolvedValue([
                    { changedBy: 'user-9', createdAt: new Date('2026-06-01T00:00:00.000Z') },
                ]);

                await signalingService.approveSummary('ctx-item-123');

                expect(mockHarnessGateway.signalApproval).not.toHaveBeenCalled();
            });
        });

        // ===================================================================
        // TASK-355 Phase D (Slice 5c) — updateSummary edit-signal SENDER.
        //
        // A clinician edit of an optimistically-delivered draft that is STILL
        // under assurance (DRAFT_PENDING_SENSORS) is forwarded to the running
        // harness workflow's `edit` signal so assurance re-binds + re-runs on the
        // edited version (Q3) and silent regen-if-untouched is disabled (Q1).
        // Best-effort: the MODIFIED_SUMMARY version write is the source of truth;
        // a signal failure never rolls back the edit. Edits outside that window
        // (any other consultation status) do NOT signal.
        // ===================================================================
        describe('updateSummary — harness edit signal (TASK-355 Slice 5c)', () => {
            let mockHarnessGateway: ReturnType<typeof createMockHarnessGatewayService>;
            let editService: SummaryService;

            beforeEach(() => {
                mockHarnessGateway = createMockHarnessGatewayService();
                editService = new SummaryService(
                    mockContextItemRepository as any,
                    mockConsultationRepository as any,
                    mockSummaryMetaRepository as any,
                    mockNamedEntityRepository as any,
                    mockHttpService as any,
                    mockConfigService as any,
                    mockEventEmitter as any,
                    mockClsService as any,
                    mockContextItemVersionRepository as any,
                    mockPromptAssemblyService as any,
                    undefined, // secretsService
                    undefined, // userProfileRepository
                    undefined, // harnessAuditService
                    mockHarnessGateway as any, // harnessGatewayService (Lane G)
                );
                mockContextItemRepository.findById.mockResolvedValue(
                    createMockContextItem({
                        id: 'ctx-edit-1',
                        consultationId: 'consultation-1',
                        content: 'old content',
                        currentVersionNumber: 1,
                    }),
                );
                mockContextItemVersionRepository.getVersionsByChangeReason.mockResolvedValue([]);
                mockContextItemVersionRepository.create.mockResolvedValue({ id: 'edited-version-1' });
                mockContextItemRepository.update.mockImplementation((_id: string, item: unknown) =>
                    Promise.resolve({ ...(item as object), createdAt: new Date(), updatedAt: new Date() }),
                );
            });

            it('forwards the edit (content + new versionId + editor) when the draft is still DRAFT_PENDING_SENSORS', async () => {
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-1',
                    tenantId: 'tenant-1',
                    status: ConsultationStatus.DRAFT_PENDING_SENSORS,
                });

                await editService.updateSummary('ctx-edit-1', { content: 'S: edited subjective ... P: edited plan' });

                expect(mockHarnessGateway.signalEdit).toHaveBeenCalledTimes(1);
                expect(mockHarnessGateway.signalEdit).toHaveBeenCalledWith(
                    'consultation-1',
                    expect.objectContaining({
                        content: 'S: edited subjective ... P: edited plan',
                        contextItemVersionId: 'edited-version-1',
                        editedBy: 'user-1',
                    }),
                );
            });

            it('does NOT signal when the consultation is not in DRAFT_PENDING_SENSORS', async () => {
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-1',
                    tenantId: 'tenant-1',
                    status: ConsultationStatus.PENDING_REVIEW,
                });

                await editService.updateSummary('ctx-edit-1', { content: 'edited' });

                expect(mockHarnessGateway.signalEdit).not.toHaveBeenCalled();
            });

            it('does NOT signal when there is no consultation record', async () => {
                mockConsultationRepository.findById.mockResolvedValue(null);

                await editService.updateSummary('ctx-edit-1', { content: 'edited' });

                expect(mockHarnessGateway.signalEdit).not.toHaveBeenCalled();
            });

            it('still completes the edit when the harness edit signal throws (best-effort, not rolled back)', async () => {
                mockConsultationRepository.findById.mockResolvedValue({
                    id: 'consultation-1',
                    tenantId: 'tenant-1',
                    status: ConsultationStatus.DRAFT_PENDING_SENSORS,
                });
                mockHarnessGateway.signalEdit.mockRejectedValue(new Error('harness unreachable'));

                const result = await editService.updateSummary('ctx-edit-1', { content: 'edited' });

                expect(result).toBeDefined();
                expect(mockContextItemVersionRepository.create).toHaveBeenCalledTimes(1);
            });
        });

        describe('extractEntities', () => {
            it('throws NotFoundException when target context item belongs to another tenant', async () => {
                mockContextItemRepository.findById.mockResolvedValue(
                    createMockContextItem({
                        id: 'ctx-other',
                        tenantId: 'tenant-OTHER',
                        content: 'cross-tenant content',
                    }),
                );

                await expect(
                    service.extractEntities('ctx-other'),
                ).rejects.toThrow(NotFoundException);
                expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
                expect(mockNamedEntityRepository.create).not.toHaveBeenCalled();
            });
        });
    });
});
