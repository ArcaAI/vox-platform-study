/**
 * HarnessInternalService Unit Tests (TASK-330 Phase 1 — Lane G)
 *
 * The INBOUND apps/api half of the gate adapter. Three operations the harness
 * calls back into apps/api (which stays the sole DB writer / system-of-record):
 *   - persistEntities: persist NamedEntity rows from NLP
 *   - assemble:        PromptAssemblyService (incl. NER injection + SOAP responseFormat)
 *   - persistDraft:    ContextItem + SummaryMeta + status PENDING_REVIEW + SSE + WORM audit
 *
 * Each re-establishes CLS (cls.run + cls.set) from the body `tenantId` because
 * the harness calls these out-of-band of the API edge ClsModule middleware.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ConsultationStatus, HarnessAuditAction } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';

// Mock the domain factories so we can assert on plain-object creation args
// (entity classes store data behind getters, which objectContaining can't see).
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        NamedEntityFactory: {
            CreateNamedEntity: vi.fn((data) => ({ id: 'ne-temp', ...data })),
        },
        ContextItemFactory: {
            CreateRawSummary: vi.fn((tenantId, consultationId, content, dnaWritingStyleId, createdBy) => ({
                id: 'ctx-draft-temp',
                tenantId,
                consultationId,
                content,
                dnaWritingStyleId,
                createdBy,
                type: 'RAW_SUMMARY',
            })),
        },
        SummaryMetaFactory: {
            CreateSummaryMeta: vi.fn((props) => ({ id: 'sm-temp', ...props })),
        },
    };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const createMockClsService = () => {
    const store = new Map<string, unknown>();
    return {
        run: vi.fn((...args: unknown[]) => {
            const callback = (args.length === 1 ? args[0] : args[1]) as () => unknown;
            return callback();
        }),
        set: vi.fn((key: string, value: unknown) => store.set(key, value)),
        get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
    };
};

const createMockContextItemRepository = () => ({
    findTranscripts: vi.fn().mockResolvedValue([{ id: 'tx-1', content: 'Patient reports chest pain. BP 120/80.' }]),
    create: vi.fn().mockResolvedValue({ id: 'ctx-draft-1', content: 'S: ...' }),
});

const createMockConsultationRepository = () => ({
    findById: vi.fn().mockResolvedValue({
        id: 'consultation-1',
        tenantId: 'tenant-1',
        departmentId: 'dept-1',
        parentConsultationId: null,
        status: ConsultationStatus.RECORDING,
        updatedBy: null,
    }),
    update: vi.fn().mockResolvedValue({ id: 'consultation-1' }),
});

const createMockNamedEntityRepository = () => ({
    create: vi.fn().mockImplementation((e) => Promise.resolve({ id: `ne-${e.text}` })),
    findByConsultation: vi.fn().mockResolvedValue([
        {
            text: 'chest pain',
            className: 'CONDITION',
            normalizedText: 'chest pain',
            startOffset: 16,
            endOffset: 26,
            transcriptStartOffset: 16,
            transcriptEndOffset: 26,
        },
    ]),
});

const createMockSummaryMetaRepository = () => ({
    create: vi.fn().mockResolvedValue({ id: 'sm-1' }),
});

const createMockPromptAssemblyService = () => ({
    assemble: vi.fn().mockResolvedValue({
        userPrompt: 'assembled user prompt with NER',
        systemPrompt: 'You are a medical scribe AI assistant.',
        hyperparameters: { temperature: 0.2 },
        responseFormat: { type: 'json_schema', json_schema: { title: 'SOAP' }, strict: true },
        resolvedFrom: 'department',
        promptId: 'prompt-tpl-1',
    }),
});

const createMockPromptTemplateRepository = () => ({
    findById: vi.fn().mockResolvedValue({ id: 'prompt-tpl-1', currentVersionNumber: 3 }),
});

const createMockHarnessAuditService = () => ({
    append: vi.fn().mockResolvedValue({ id: 'audit-1' }),
});

const createMockJobService = () => ({
    notifyProgress: vi.fn().mockResolvedValue(undefined),
    notifyComplete: vi.fn().mockResolvedValue(undefined),
});

describe('HarnessInternalService', () => {
    let service: HarnessInternalService;
    let cls: ReturnType<typeof createMockClsService>;
    let contextItemRepository: ReturnType<typeof createMockContextItemRepository>;
    let consultationRepository: ReturnType<typeof createMockConsultationRepository>;
    let namedEntityRepository: ReturnType<typeof createMockNamedEntityRepository>;
    let summaryMetaRepository: ReturnType<typeof createMockSummaryMetaRepository>;
    let promptAssemblyService: ReturnType<typeof createMockPromptAssemblyService>;
    let promptTemplateRepository: ReturnType<typeof createMockPromptTemplateRepository>;
    let harnessAuditService: ReturnType<typeof createMockHarnessAuditService>;
    let jobService: ReturnType<typeof createMockJobService>;

    beforeEach(() => {
        vi.clearAllMocks();
        cls = createMockClsService();
        contextItemRepository = createMockContextItemRepository();
        consultationRepository = createMockConsultationRepository();
        namedEntityRepository = createMockNamedEntityRepository();
        summaryMetaRepository = createMockSummaryMetaRepository();
        promptAssemblyService = createMockPromptAssemblyService();
        promptTemplateRepository = createMockPromptTemplateRepository();
        harnessAuditService = createMockHarnessAuditService();
        jobService = createMockJobService();

        service = new HarnessInternalService(
            contextItemRepository as any,
            consultationRepository as any,
            namedEntityRepository as any,
            summaryMetaRepository as any,
            promptAssemblyService as any,
            promptTemplateRepository as any,
            harnessAuditService as any,
            cls as any,
            jobService as any,
        );
    });

    // =========================================================================
    // persistEntities
    // =========================================================================

    describe('persistEntities', () => {
        it('persists each NamedEntity (text/type/offsets) and re-establishes CLS from tenantId', async () => {
            const result = await service.persistEntities('consultation-1', {
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                contextItemId: 'tx-1',
                entities: [
                    { text: 'Metformin', type: 'MEDICATION', startOffset: 5, endOffset: 14, confidence: 0.9 },
                    { text: 'Diabetes', type: 'CONDITION', startOffset: 20, endOffset: 28 },
                ],
            });

            expect(cls.run).toHaveBeenCalledTimes(1);
            expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
            expect(cls.set).toHaveBeenCalledWith('user', expect.objectContaining({ tenantId: 'tenant-1' }));

            expect(namedEntityRepository.create).toHaveBeenCalledTimes(2);
            const firstArg = namedEntityRepository.create.mock.calls[0][0];
            expect(firstArg).toEqual(
                expect.objectContaining({
                    tenantId: 'tenant-1',
                    contextItemId: 'tx-1',
                    text: 'Metformin',
                    className: 'MEDICATION',
                    startOffset: 5,
                    endOffset: 14,
                    confidence: 0.9,
                }),
            );

            expect(result.savedCount).toBe(2);
            expect(result.entityIds).toEqual(['ne-Metformin', 'ne-Diabetes']);
        });

        it('throws BadRequestException and persists nothing when tenantId is missing', async () => {
            await expect(
                service.persistEntities('consultation-1', { tenantId: '', contextItemId: 'tx-1', entities: [] } as any),
            ).rejects.toThrow(BadRequestException);
            expect(namedEntityRepository.create).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // assemble
    // =========================================================================

    describe('assemble', () => {
        it('injects findByConsultation NER entities + returns prompt, responseFormat, templateId/version', async () => {
            const result = await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            expect(cls.run).toHaveBeenCalledTimes(1);
            expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
            expect(namedEntityRepository.findByConsultation).toHaveBeenCalledWith('consultation-1');

            // NER entities flattened into assemble({ nerEntities })
            expect(promptAssemblyService.assemble).toHaveBeenCalledWith(
                expect.objectContaining({
                    departmentId: 'dept-1',
                    transcript: expect.stringContaining('chest pain'),
                    nerEntities: expect.arrayContaining([
                        expect.objectContaining({ text: 'chest pain', type: 'CONDITION', startOffset: 16, endOffset: 26 }),
                    ]),
                }),
            );

            expect(result.userPrompt).toBe('assembled user prompt with NER');
            expect(result.responseFormat).toEqual({ type: 'json_schema', json_schema: { title: 'SOAP' }, strict: true });
            expect(result.promptTemplateId).toBe('prompt-tpl-1');
            expect(result.promptVersion).toBe('3');
            expect(result.resolvedFrom).toBe('department');
        });

        it('passes an explicit template override through to assemble', async () => {
            await service.assemble('consultation-1', { tenantId: 'tenant-1', template: 'Cardiology-Report' });

            expect(promptAssemblyService.assemble).toHaveBeenCalledWith(
                expect.objectContaining({ explicitTemplate: 'Cardiology-Report' }),
            );
        });
    });

    // =========================================================================
    // persistDraft
    // =========================================================================

    describe('persistDraft', () => {
        const draftBody = () => ({
            tenantId: 'tenant-1',
            userId: 'doctor-1',
            jobId: 'job-1',
            content: 'S: chest pain O: BP 120/80 A: stable P: review',
            modelName: 'gpt-x',
            modelVersion: 'v9',
            sensorScores: { entityFaithfulness: 0.95, coverage: 0.9, schemaValid: 1, citationPresence: 1, numericDose: 1 },
            citationsMap: { claims: [{ id: 'c1', status: 'verified' }] },
            entityFaithfulnessScore: 0.95,
            coverageScore: 0.9,
            ragTriadScore: 0.92,
            promptTemplateId: 'prompt-tpl-1',
            promptVersion: '3',
            gateDecision: 'PASS',
        });

        it('creates RAW_SUMMARY, persists SummaryMeta with scores+citations, sets PENDING_REVIEW, and returns contextItemId', async () => {
            const result = await service.persistDraft('consultation-1', draftBody());

            expect(cls.run).toHaveBeenCalledTimes(1);
            expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');

            // RAW_SUMMARY context item
            expect(contextItemRepository.create).toHaveBeenCalledTimes(1);

            // SummaryMeta carries score columns + citationsMap + modelName + promptVersion
            expect(summaryMetaRepository.create).toHaveBeenCalledTimes(1);
            const smArg = summaryMetaRepository.create.mock.calls[0][0];
            expect(smArg).toEqual(
                expect.objectContaining({
                    tenantId: 'tenant-1',
                    contextItemId: 'ctx-draft-1',
                    entityFaithfulnessScore: 0.95,
                    coverageScore: 0.9,
                    ragTriadScore: 0.92,
                    citationsMap: { claims: [{ id: 'c1', status: 'verified' }] },
                    modelName: 'gpt-x',
                    promptVersion: '3',
                }),
            );

            // status -> PENDING_REVIEW
            expect(consultationRepository.update).toHaveBeenCalledWith(
                'consultation-1',
                expect.objectContaining({ status: ConsultationStatus.PENDING_REVIEW }),
            );

            expect(result).toEqual({ contextItemId: 'ctx-draft-1' });
        });

        it('appends both GENERATE and SENSOR_RUN WORM audit events', async () => {
            await service.persistDraft('consultation-1', draftBody());

            expect(harnessAuditService.append).toHaveBeenCalledTimes(2);
            const actions = harnessAuditService.append.mock.calls.map((c: any[]) => c[0].action);
            expect(actions).toContain(HarnessAuditAction.GENERATE);
            expect(actions).toContain(HarnessAuditAction.SENSOR_RUN);

            const sensorEvent = harnessAuditService.append.mock.calls
                .map((c: any[]) => c[0])
                .find((e: any) => e.action === HarnessAuditAction.SENSOR_RUN);
            expect(sensorEvent.sensorScores).toEqual(
                expect.objectContaining({ entityFaithfulness: 0.95, coverage: 0.9 }),
            );
            expect(sensorEvent.gateDecision).toBe('PASS');
        });

        it('emits SSE progress via notifyProgress when a jobId is supplied', async () => {
            await service.persistDraft('consultation-1', draftBody());
            expect(jobService.notifyProgress).toHaveBeenCalledWith('job-1', expect.any(Number), expect.any(String));
        });

        it('does not call notifyProgress when no jobId is supplied', async () => {
            const body = draftBody();
            delete (body as any).jobId;
            await service.persistDraft('consultation-1', body);
            expect(jobService.notifyProgress).not.toHaveBeenCalled();
            expect(contextItemRepository.create).toHaveBeenCalledTimes(1);
        });

        it('still persists the draft when the best-effort SSE notify throws', async () => {
            jobService.notifyProgress.mockRejectedValue(new Error('redis down'));
            const result = await service.persistDraft('consultation-1', draftBody());
            expect(result).toEqual({ contextItemId: 'ctx-draft-1' });
            expect(consultationRepository.update).toHaveBeenCalled();
        });

        it('throws BadRequestException when tenantId is missing', async () => {
            await expect(
                service.persistDraft('consultation-1', { tenantId: '', content: 'x' } as any),
            ).rejects.toThrow(BadRequestException);
            expect(contextItemRepository.create).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // recordGateDecision
    // =========================================================================

    describe('recordGateDecision', () => {
        const gateBody = () => ({
            tenantId: 'tenant-1',
            userId: 'doctor-1',
            decision: 'SIGNED',
            gateDecision: 'PASS',
            contextItemVersionId: 'ver-1',
            attestationHash: 'hash-abc',
            clinicianId: 'doctor-1',
        });

        it('re-establishes CLS and appends a GATE_DECISION WORM audit event', async () => {
            const result = await service.recordGateDecision('consultation-1', gateBody());

            expect(cls.run).toHaveBeenCalledTimes(1);
            expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');

            expect(harnessAuditService.append).toHaveBeenCalledTimes(1);
            const event = harnessAuditService.append.mock.calls[0][0];
            expect(event).toEqual(
                expect.objectContaining({
                    tenantId: 'tenant-1',
                    consultationId: 'consultation-1',
                    action: HarnessAuditAction.GATE_DECISION,
                    gateDecision: 'PASS',
                    contextItemVersionId: 'ver-1',
                    attestationHash: 'hash-abc',
                    clinicianId: 'doctor-1',
                }),
            );

            expect(result).toEqual({ recorded: true });
        });

        it('throws BadRequestException and records nothing when tenantId is missing', async () => {
            await expect(
                service.recordGateDecision('consultation-1', { tenantId: '' } as any),
            ).rejects.toThrow(BadRequestException);
            expect(harnessAuditService.append).not.toHaveBeenCalled();
        });
    });
});
