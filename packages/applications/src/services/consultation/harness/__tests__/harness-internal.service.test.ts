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
import { ConsultationStatus, HarnessAuditAction, SummaryMetaFactory } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';
import { HARNESS_DRAFT_PHASE } from '../dto';

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
    findCaseNotes: vi.fn().mockResolvedValue([]),
    findWorknotes: vi.fn().mockResolvedValue([]),
    findAttachments: vi.fn().mockResolvedValue([]),
    // TASK-355 Phase C (R-6) — the live SOAP snapshot lookup; default empty
    // (cold path) so pre-existing assemble/persistDraft tests stay green.
    findPreSummaries: vi.fn().mockResolvedValue([]),
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
    // TASK-355 Phase D — finalizeAssurance backfills the early-persisted meta.
    findByContextItem: vi.fn().mockResolvedValue({
        id: 'sm-early-1',
        contextItemId: 'ctx-draft-1',
        ragTriadScore: null,
        citationsMap: null,
        guardrailDecisions: null,
        gateDecision: null,
        assuranceCompletedAt: null,
    }),
    update: vi.fn().mockImplementation((id, entity) => Promise.resolve({ id, ...entity })),
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

// TASK-344 Workstream B — manual doctor highlights threaded into assemble.
const createMockHighlightRepository = () => ({
    findByConsultation: vi.fn().mockResolvedValue([]),
});

// TASK-355 Phase C (R-6) — warm-start kill-switch. Default OFF (prod default);
// pass `true` to exercise the ON behavior. Mirrors how sibling harness/summary
// services read config (ConfigService.get).
const createMockConfigService = (warmStartEnabled = false) => ({
    get: vi.fn((key: string) =>
        key === 'HARNESS_WARM_START_ENABLED' ? (warmStartEnabled ? 'true' : undefined) : undefined,
    ),
});

// TASK-355 Phase D Slice 5d — the live assurance feed. finalizeAssurance publishes
// the terminal `assurance_complete` (aggregate verdict + safetyFlag + postSignAlert)
// to close the SSE stream. Best-effort: a publish failure must not break finalize.
const createMockHarnessAssuranceService = () => ({
    reportClaim: vi.fn().mockResolvedValue({ ok: true }),
    publishComplete: vi.fn().mockResolvedValue({ ok: true }),
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
    let highlightRepository: ReturnType<typeof createMockHighlightRepository>;
    let configService: ReturnType<typeof createMockConfigService>;
    let assuranceService: ReturnType<typeof createMockHarnessAssuranceService>;

    // TASK-355 Phase C (R-6) — (re)build the service with the warm-start flag in a
    // known state. Default OFF mirrors prod; warm-start tests call buildService(true).
    const buildService = (warmStartEnabled = false) => {
        configService = createMockConfigService(warmStartEnabled);
        return new HarnessInternalService(
            contextItemRepository as any,
            consultationRepository as any,
            namedEntityRepository as any,
            summaryMetaRepository as any,
            promptAssemblyService as any,
            promptTemplateRepository as any,
            harnessAuditService as any,
            cls as any,
            jobService as any,
            highlightRepository as any,
            configService as any,
            assuranceService as any,
        );
    };

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
        highlightRepository = createMockHighlightRepository();
        assuranceService = createMockHarnessAssuranceService();

        // Default OFF — pre-Phase-C behavior. Warm-start tests rebuild with ON.
        service = buildService(false);
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

        it('folds case notes, work notes, and attachments into the assembled prompt (TASK-342 GAP #2)', async () => {
            contextItemRepository.findCaseNotes.mockResolvedValue([
                { id: 'cn-1', content: 'Patient anxious about results' },
            ]);
            contextItemRepository.findWorknotes.mockResolvedValue([
                { id: 'wn-1', content: 'Order troponin' },
            ]);
            contextItemRepository.findAttachments.mockResolvedValue([
                { id: 'at-1', content: 'Troponin 0.9 ng/mL (elevated)' },
            ]);

            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            expect(contextItemRepository.findCaseNotes).toHaveBeenCalledWith('consultation-1');
            expect(contextItemRepository.findWorknotes).toHaveBeenCalledWith('consultation-1');
            expect(contextItemRepository.findAttachments).toHaveBeenCalledWith('consultation-1');

            expect(promptAssemblyService.assemble).toHaveBeenCalledWith(
                expect.objectContaining({
                    clinicianNotes: expect.arrayContaining([
                        expect.stringContaining('Patient anxious about results'),
                        expect.stringContaining('Order troponin'),
                    ]),
                    attachments: expect.arrayContaining([
                        expect.stringContaining('Troponin 0.9 ng/mL (elevated)'),
                    ]),
                }),
            );
        });

        it('prefers an attachment\'s extracted text over the filename label (TASK-342 GAP #5)', async () => {
            contextItemRepository.findAttachments.mockResolvedValue([
                {
                    id: 'at-1',
                    content: 'Lab/exam result: cbc.txt',
                    metaData: { subType: 'LAB_RESULT', extractedText: 'WBC 11.2 x10^9/L (high); Hgb 13.1 g/dL' },
                },
            ]);

            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            const call = (promptAssemblyService.assemble as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
            // The extracted file CONTENTS reach the authoritative prompt …
            expect(call.attachments).toEqual(expect.arrayContaining([expect.stringContaining('WBC 11.2 x10^9/L (high)')]));
            // … and the bare "Lab/exam result: <name>" label is not threaded when text exists.
            expect(call.attachments).not.toEqual(expect.arrayContaining([expect.stringContaining('Lab/exam result: cbc.txt')]));
        });

        it('threads empty notes/attachments arrays when none exist', async () => {
            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            expect(promptAssemblyService.assemble).toHaveBeenCalledWith(
                expect.objectContaining({ clinicianNotes: [], attachments: [] }),
            );
        });

        it('folds the doctor\'s manual highlights into the assembled prompt (TASK-344 Workstream B)', async () => {
            highlightRepository.findByConsultation.mockResolvedValue([
                { id: 'hl-1', exact: 'chest pain' },
                { id: 'hl-2', exact: 'radiating to the left arm' },
                { id: 'hl-3', exact: '   ' }, // blank → filtered out
            ]);

            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            expect(highlightRepository.findByConsultation).toHaveBeenCalledWith('consultation-1');
            expect(promptAssemblyService.assemble).toHaveBeenCalledWith(
                expect.objectContaining({
                    highlights: expect.arrayContaining([
                        expect.stringContaining('chest pain'),
                        expect.stringContaining('radiating to the left arm'),
                    ]),
                }),
            );
            const call = (promptAssemblyService.assemble as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
            expect(call.highlights).toHaveLength(2); // blank entry dropped
        });

        it('threads an empty highlights array when none exist', async () => {
            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            expect(promptAssemblyService.assemble).toHaveBeenCalledWith(
                expect.objectContaining({ highlights: [] }),
            );
        });

        // ── Warm-start from the live SOAP snapshot (TASK-355 Phase C — R-6) ──
        it('injects the LIVE_SOAP_SNAPSHOT content as preSummaryText when a snapshot exists', async () => {
            service = buildService(true); // warm-start ON
            contextItemRepository.findPreSummaries.mockResolvedValue([
                {
                    id: 'ps-live-1',
                    content: 'S: chest pain O: BP 120/80',
                    metaData: { subType: 'LIVE_SOAP_SNAPSHOT' },
                    createdAt: new Date(),
                },
            ]);

            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            expect(contextItemRepository.findPreSummaries).toHaveBeenCalledWith('consultation-1');
            expect(promptAssemblyService.assemble).toHaveBeenCalledWith(
                expect.objectContaining({ preSummaryText: 'S: chest pain O: BP 120/80' }),
            );
        });

        it('omits preSummaryText when no LIVE_SOAP_SNAPSHOT exists (cold path still works)', async () => {
            service = buildService(true); // warm-start ON
            contextItemRepository.findPreSummaries.mockResolvedValue([]);

            const result = await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            const call = (promptAssemblyService.assemble as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
            expect(call.preSummaryText).toBeUndefined();
            // Cold-path return shape unchanged.
            expect(result.userPrompt).toBe('assembled user prompt with NER');
            expect(result.responseFormat).toEqual({ type: 'json_schema', json_schema: { title: 'SOAP' }, strict: true });
            expect(result.promptTemplateId).toBe('prompt-tpl-1');
        });

        it('ignores a legacy (non-LIVE_SOAP_SNAPSHOT) pre-summary', async () => {
            service = buildService(true); // warm-start ON
            contextItemRepository.findPreSummaries.mockResolvedValue([
                { id: 'ps-legacy', content: 'historical notes', metaData: { subType: 'CASE_NOTES' }, createdAt: new Date() },
            ]);

            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            const call = (promptAssemblyService.assemble as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
            expect(call.preSummaryText).toBeUndefined();
        });

        it('selects the latest LIVE_SOAP_SNAPSHOT when multiple PRE_SUMMARY rows exist (latest wins)', async () => {
            service = buildService(true); // warm-start ON
            contextItemRepository.findPreSummaries.mockResolvedValue([
                { id: 'ps-old', content: 'old', metaData: { subType: 'LIVE_SOAP_SNAPSHOT' }, createdAt: new Date('2026-01-01T00:00:00Z') },
                { id: 'ps-legacy', content: 'legacy', metaData: { subType: 'CASE_NOTES' }, createdAt: new Date('2026-01-03T00:00:00Z') },
                { id: 'ps-new', content: 'new', metaData: { subType: 'LIVE_SOAP_SNAPSHOT' }, createdAt: new Date('2026-01-02T00:00:00Z') },
            ]);

            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            expect(promptAssemblyService.assemble).toHaveBeenCalledWith(
                expect.objectContaining({ preSummaryText: 'new' }),
            );
        });

        // ── Kill-switch OFF (default): no warm-start, no snapshot lookup ──
        it('does NOT populate preSummaryText when the flag is OFF (default), even if a snapshot exists', async () => {
            service = buildService(false); // explicit: warm-start OFF (prod default)
            contextItemRepository.findPreSummaries.mockResolvedValue([
                { id: 'ps-live-1', content: 'S: chest pain O: BP 120/80', metaData: { subType: 'LIVE_SOAP_SNAPSHOT' }, createdAt: new Date() },
            ]);

            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            const call = (promptAssemblyService.assemble as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
            expect(call.preSummaryText).toBeUndefined();
            // Airtight: the snapshot lookup is short-circuited when disabled.
            expect(contextItemRepository.findPreSummaries).not.toHaveBeenCalled();
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
            guardrailDecisions: { safety: { verdict: 'pass', harms: [] }, groundedness: { score: 0.88 } },
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
                    guardrailDecisions: { safety: { verdict: 'pass', harms: [] }, groundedness: { score: 0.88 } },
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
            // SENSOR_RUN carries the guardrail/sensor decisions alongside the sensor scores.
            expect(sensorEvent.sensorScores).toEqual(
                expect.objectContaining({
                    guardrailDecisions: { safety: { verdict: 'pass', harms: [] }, groundedness: { score: 0.88 } },
                }),
            );
            expect(sensorEvent.gateDecision).toBe('PASS');
        });

        it('does not append a REDUCED_ASSURANCE event when reducedAssurance is not set', async () => {
            await service.persistDraft('consultation-1', draftBody());

            expect(harnessAuditService.append).toHaveBeenCalledTimes(2);
            const actions = harnessAuditService.append.mock.calls.map((c: any[]) => c[0].action);
            expect(actions).not.toContain(HarnessAuditAction.REDUCED_ASSURANCE);
        });

        it('appends a REDUCED_ASSURANCE WORM event when reducedAssurance is true', async () => {
            await service.persistDraft('consultation-1', { ...draftBody(), reducedAssurance: true });

            expect(harnessAuditService.append).toHaveBeenCalledTimes(3);
            const actions = harnessAuditService.append.mock.calls.map((c: any[]) => c[0].action);
            expect(actions).toContain(HarnessAuditAction.GENERATE);
            expect(actions).toContain(HarnessAuditAction.SENSOR_RUN);
            expect(actions).toContain(HarnessAuditAction.REDUCED_ASSURANCE);

            const reducedEvent = harnessAuditService.append.mock.calls
                .map((c: any[]) => c[0])
                .find((e: any) => e.action === HarnessAuditAction.REDUCED_ASSURANCE);
            expect(reducedEvent.sensorScores).toEqual(
                expect.objectContaining({
                    guardrailDecisions: { safety: { verdict: 'pass', harms: [] }, groundedness: { score: 0.88 } },
                }),
            );
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

        // ── Warm-start provenance (TASK-355 Phase C — R-6) ──
        it('records the consumed LIVE_SOAP_SNAPSHOT id in SummaryMeta.preSummaryIds', async () => {
            service = buildService(true); // warm-start ON
            contextItemRepository.findPreSummaries.mockResolvedValue([
                { id: 'ps-live-1', content: 'S: chest pain', metaData: { subType: 'LIVE_SOAP_SNAPSHOT' }, createdAt: new Date() },
            ]);

            await service.persistDraft('consultation-1', draftBody());

            expect(SummaryMetaFactory.CreateSummaryMeta).toHaveBeenCalledWith(
                expect.objectContaining({ preSummaryIds: ['ps-live-1'] }),
            );
        });

        it('records an empty preSummaryIds when no snapshot exists (cold path provenance explicit)', async () => {
            service = buildService(true); // warm-start ON
            contextItemRepository.findPreSummaries.mockResolvedValue([]);

            await service.persistDraft('consultation-1', draftBody());

            expect(SummaryMetaFactory.CreateSummaryMeta).toHaveBeenCalledWith(
                expect.objectContaining({ preSummaryIds: [] }),
            );
        });

        it('records the same latest-wins snapshot id that assemble would inject (shared-helper determinism)', async () => {
            service = buildService(true); // warm-start ON
            contextItemRepository.findPreSummaries.mockResolvedValue([
                { id: 'ps-old', content: 'old', metaData: { subType: 'LIVE_SOAP_SNAPSHOT' }, createdAt: new Date('2026-01-01T00:00:00Z') },
                { id: 'ps-legacy', content: 'legacy', metaData: { subType: 'CASE_NOTES' }, createdAt: new Date('2026-01-03T00:00:00Z') },
                { id: 'ps-new', content: 'new', metaData: { subType: 'LIVE_SOAP_SNAPSHOT' }, createdAt: new Date('2026-01-02T00:00:00Z') },
            ]);

            await service.persistDraft('consultation-1', draftBody());

            expect(SummaryMetaFactory.CreateSummaryMeta).toHaveBeenCalledWith(
                expect.objectContaining({ preSummaryIds: ['ps-new'] }),
            );
        });

        // ── Kill-switch OFF (default): no provenance, no snapshot lookup ──
        it('writes empty preSummaryIds when the flag is OFF (default), even if a snapshot exists', async () => {
            service = buildService(false); // explicit: warm-start OFF (prod default)
            contextItemRepository.findPreSummaries.mockResolvedValue([
                { id: 'ps-live-1', content: 'S: chest pain', metaData: { subType: 'LIVE_SOAP_SNAPSHOT' }, createdAt: new Date() },
            ]);

            await service.persistDraft('consultation-1', draftBody());

            expect(SummaryMetaFactory.CreateSummaryMeta).toHaveBeenCalledWith(
                expect.objectContaining({ preSummaryIds: [] }),
            );
            // Airtight: the snapshot lookup is short-circuited when disabled.
            expect(contextItemRepository.findPreSummaries).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // persistDraft — TASK-355 Phase D early delivery (DRAFT_PENDING_SENSORS)
    // =========================================================================

    describe('persistDraft — Phase D early delivery', () => {
        const earlyBody = () => ({
            tenantId: 'tenant-1',
            userId: 'doctor-1',
            jobId: 'job-1',
            content: 'S: chest pain O: BP 120/80 A: stable P: review',
            modelName: 'gpt-x',
            modelVersion: 'v9',
            entityFaithfulnessScore: 0.95,
            coverageScore: 0.9,
            // Inferential fields may be present on the DTO but MUST be withheld in
            // the early phase (the verdict does not exist yet).
            ragTriadScore: 0.92,
            citationsMap: { claims: [{ id: 'c1', status: 'verified' }] },
            guardrailDecisions: { safety: { verdict: 'pass' } },
            gateDecision: 'PASS',
            phase: HARNESS_DRAFT_PHASE.EARLY,
        });

        it('sets status DRAFT_PENDING_SENSORS (readable, not yet signable)', async () => {
            await service.persistDraft('consultation-1', earlyBody());
            expect(consultationRepository.update).toHaveBeenCalledWith(
                'consultation-1',
                expect.objectContaining({ status: ConsultationStatus.DRAFT_PENDING_SENSORS }),
            );
        });

        it('persists computational scores but WITHHOLDS the inferential verdict (gateDecision/assuranceCompletedAt/ragTriad/citations/guardrails NULL)', async () => {
            await service.persistDraft('consultation-1', earlyBody());
            const smArg = summaryMetaRepository.create.mock.calls[0][0];
            expect(smArg).toEqual(
                expect.objectContaining({
                    entityFaithfulnessScore: 0.95,
                    coverageScore: 0.9,
                    ragTriadScore: null,
                    citationsMap: null,
                    guardrailDecisions: null,
                    gateDecision: null,
                    assuranceCompletedAt: null,
                }),
            );
        });

        it('writes ONLY the GENERATE audit (no SENSOR_RUN — WORM truthfulness)', async () => {
            await service.persistDraft('consultation-1', earlyBody());
            expect(harnessAuditService.append).toHaveBeenCalledTimes(1);
            expect(harnessAuditService.append.mock.calls[0][0].action).toBe(HarnessAuditAction.GENERATE);
        });

        it('never writes SENSOR_RUN/REDUCED_ASSURANCE in the early phase even if reducedAssurance is set', async () => {
            await service.persistDraft('consultation-1', { ...earlyBody(), reducedAssurance: true });
            const actions = harnessAuditService.append.mock.calls.map((c: any[]) => c[0].action);
            expect(actions).not.toContain(HarnessAuditAction.SENSOR_RUN);
            expect(actions).not.toContain(HarnessAuditAction.REDUCED_ASSURANCE);
        });

        it('returns the new RAW_SUMMARY contextItemId (so the workflow can target finalizeAssurance)', async () => {
            const result = await service.persistDraft('consultation-1', earlyBody());
            expect(result).toEqual({ contextItemId: 'ctx-draft-1' });
        });
    });

    // =========================================================================
    // finalizeAssurance — TASK-355 Phase D second phase
    // =========================================================================

    describe('finalizeAssurance', () => {
        const finalizeBody = () => ({
            tenantId: 'tenant-1',
            userId: 'doctor-1',
            jobId: 'job-1',
            contextItemId: 'ctx-draft-1',
            ragTriadScore: 0.92,
            citationsMap: { claims: [{ id: 'c1', status: 'verified' }] },
            guardrailDecisions: { safety: { verdict: 'pass' }, groundedness: { score: 0.88 } },
            sensorScores: { entityFaithfulness: 0.95, coverage: 0.9 },
            gateDecision: 'PASS',
            modelName: 'gpt-x',
            modelVersion: 'v9',
            promptTemplateId: 'prompt-tpl-1',
            promptVersion: '3',
        });

        beforeEach(() => {
            // At finalize time the consultation sits in DRAFT_PENDING_SENSORS.
            consultationRepository.findById.mockResolvedValue({
                id: 'consultation-1',
                tenantId: 'tenant-1',
                status: ConsultationStatus.DRAFT_PENDING_SENSORS,
                updatedBy: null,
            });
        });

        it('backfills the early SummaryMeta with the inferential verdict + assuranceCompletedAt', async () => {
            await service.finalizeAssurance('consultation-1', finalizeBody());
            expect(summaryMetaRepository.findByContextItem).toHaveBeenCalledWith('ctx-draft-1');
            expect(summaryMetaRepository.update).toHaveBeenCalledTimes(1);
            const [, updated] = summaryMetaRepository.update.mock.calls[0];
            expect(updated.ragTriadScore).toBe(0.92);
            expect(updated.gateDecision).toBe('PASS');
            expect(updated.guardrailDecisions).toEqual({ safety: { verdict: 'pass' }, groundedness: { score: 0.88 } });
            expect(updated.assuranceCompletedAt).toBeInstanceOf(Date);
        });

        it('flips DRAFT_PENDING_SENSORS -> PENDING_REVIEW', async () => {
            await service.finalizeAssurance('consultation-1', finalizeBody());
            expect(consultationRepository.update).toHaveBeenCalledWith(
                'consultation-1',
                expect.objectContaining({ status: ConsultationStatus.PENDING_REVIEW }),
            );
        });

        it('records the DEFERRED SENSOR_RUN WORM audit (verdict + guardrails)', async () => {
            await service.finalizeAssurance('consultation-1', finalizeBody());
            const sensorEvent = harnessAuditService.append.mock.calls
                .map((c: any[]) => c[0])
                .find((e: any) => e.action === HarnessAuditAction.SENSOR_RUN);
            expect(sensorEvent).toBeDefined();
            expect(sensorEvent.gateDecision).toBe('PASS');
            expect(sensorEvent.sensorScores).toEqual(
                expect.objectContaining({
                    guardrailDecisions: { safety: { verdict: 'pass' }, groundedness: { score: 0.88 } },
                }),
            );
        });

        it('is idempotent on the lifecycle flip (no status write when already PENDING_REVIEW)', async () => {
            consultationRepository.findById.mockResolvedValue({
                id: 'consultation-1',
                tenantId: 'tenant-1',
                status: ConsultationStatus.PENDING_REVIEW,
                updatedBy: null,
            });
            await service.finalizeAssurance('consultation-1', finalizeBody());
            expect(consultationRepository.update).not.toHaveBeenCalled();
            // …but it still re-stamps the verdict (safe to repeat).
            expect(summaryMetaRepository.update).toHaveBeenCalledTimes(1);
        });

        it('appends REDUCED_ASSURANCE when reducedAssurance is true', async () => {
            await service.finalizeAssurance('consultation-1', { ...finalizeBody(), reducedAssurance: true });
            const actions = harnessAuditService.append.mock.calls.map((c: any[]) => c[0].action);
            expect(actions).toContain(HarnessAuditAction.REDUCED_ASSURANCE);
        });

        it('fail-closed: throws BadRequestException when no early SummaryMeta exists', async () => {
            summaryMetaRepository.findByContextItem.mockResolvedValue(null);
            await expect(service.finalizeAssurance('consultation-1', finalizeBody())).rejects.toThrow(BadRequestException);
            expect(consultationRepository.update).not.toHaveBeenCalled();
        });

        it('throws BadRequestException when tenantId is missing', async () => {
            await expect(
                service.finalizeAssurance('consultation-1', { tenantId: '', contextItemId: 'ctx-draft-1' } as any),
            ).rejects.toThrow(BadRequestException);
        });

        // -----------------------------------------------------------------
        // Q2b — late adverse verdict AFTER an early sign (note immutable).
        // If the clinician early-signed (Q2a) before assurance landed, the
        // consultation is already SIGNED at finalize time. The signed note
        // STANDS (no status regression); an adverse verdict (FLAG/REGEN) is
        // recorded as a POST_SIGN_FLAG WORM annotation for amendment/follow-up.
        // -----------------------------------------------------------------

        it('Q2b — records POST_SIGN_FLAG and does NOT regress status when a safety FLAG lands after an early sign', async () => {
            consultationRepository.findById.mockResolvedValue({
                id: 'consultation-1',
                tenantId: 'tenant-1',
                status: ConsultationStatus.SIGNED,
                updatedBy: null,
            });

            await service.finalizeAssurance('consultation-1', {
                ...finalizeBody(),
                gateDecision: 'FLAG',
                guardrailDecisions: { safety: { decision: 'FLAG' } },
            });

            const actions = harnessAuditService.append.mock.calls.map((c: any[]) => c[0].action);
            expect(actions).toContain(HarnessAuditAction.POST_SIGN_FLAG);
            // Note stands — the signed consultation is NEVER regressed.
            expect(consultationRepository.update).not.toHaveBeenCalled();
            // The verdict is still backfilled onto the meta (audit completeness).
            expect(summaryMetaRepository.update).toHaveBeenCalledTimes(1);
        });

        it('Q2b — records POST_SIGN_FLAG for a REGEN verdict after an early sign', async () => {
            consultationRepository.findById.mockResolvedValue({
                id: 'consultation-1',
                tenantId: 'tenant-1',
                status: ConsultationStatus.SIGNED,
                updatedBy: null,
            });

            await service.finalizeAssurance('consultation-1', { ...finalizeBody(), gateDecision: 'REGEN' });

            const actions = harnessAuditService.append.mock.calls.map((c: any[]) => c[0].action);
            expect(actions).toContain(HarnessAuditAction.POST_SIGN_FLAG);
        });

        it('Q2b — does NOT record POST_SIGN_FLAG when the post-sign verdict is PASS', async () => {
            consultationRepository.findById.mockResolvedValue({
                id: 'consultation-1',
                tenantId: 'tenant-1',
                status: ConsultationStatus.SIGNED,
                updatedBy: null,
            });

            await service.finalizeAssurance('consultation-1', { ...finalizeBody(), gateDecision: 'PASS' });

            const actions = harnessAuditService.append.mock.calls.map((c: any[]) => c[0].action);
            expect(actions).not.toContain(HarnessAuditAction.POST_SIGN_FLAG);
            // The deferred verdict is still recorded.
            expect(actions).toContain(HarnessAuditAction.SENSOR_RUN);
        });

        it('does NOT record POST_SIGN_FLAG on the normal DRAFT_PENDING_SENSORS path even with a FLAG verdict', async () => {
            // Default beforeEach status is DRAFT_PENDING_SENSORS (not signed yet) —
            // a FLAG here surfaces through the normal verdict, not the post-sign path.
            await service.finalizeAssurance('consultation-1', {
                ...finalizeBody(),
                gateDecision: 'FLAG',
                guardrailDecisions: { safety: { decision: 'FLAG' } },
            });

            const actions = harnessAuditService.append.mock.calls.map((c: any[]) => c[0].action);
            expect(actions).not.toContain(HarnessAuditAction.POST_SIGN_FLAG);
            expect(consultationRepository.update).toHaveBeenCalledWith(
                'consultation-1',
                expect.objectContaining({ status: ConsultationStatus.PENDING_REVIEW }),
            );
        });

        // -----------------------------------------------------------------
        // Slice 5d-2 — terminal `assurance_complete` published to the SSE feed.
        // Closes the live stream with the aggregate verdict so the browser can
        // stop the spinner, enable sign-off, or surface a flag/amendment alert.
        // -----------------------------------------------------------------

        it('publishes the terminal assurance_complete carrying the aggregate verdict (PASS ⇒ no safety flag, no post-sign alert)', async () => {
            await service.finalizeAssurance('consultation-1', finalizeBody());

            expect(assuranceService.publishComplete).toHaveBeenCalledTimes(1);
            const [cid, payload] = assuranceService.publishComplete.mock.calls[0];
            expect(cid).toBe('consultation-1');
            expect(payload).toEqual(
                expect.objectContaining({
                    tenantId: 'tenant-1',
                    jobId: 'job-1',
                    gateDecision: 'PASS',
                    safetyFlag: false,
                    postSignAlert: false,
                }),
            );
        });

        it('publishes safetyFlag: true when the safety dimension is a FLAG', async () => {
            await service.finalizeAssurance('consultation-1', {
                ...finalizeBody(),
                gateDecision: 'FLAG',
                guardrailDecisions: { safety: { decision: 'FLAG' } },
            });

            const [, payload] = assuranceService.publishComplete.mock.calls[0];
            expect(payload.safetyFlag).toBe(true);
        });

        it('publishes reducedAssurance: true through the terminal event', async () => {
            await service.finalizeAssurance('consultation-1', { ...finalizeBody(), reducedAssurance: true });
            const [, payload] = assuranceService.publishComplete.mock.calls[0];
            expect(payload.reducedAssurance).toBe(true);
        });

        it('publishes postSignAlert: true when an adverse verdict lands AFTER an early sign (Q2b)', async () => {
            consultationRepository.findById.mockResolvedValue({
                id: 'consultation-1',
                tenantId: 'tenant-1',
                status: ConsultationStatus.SIGNED,
                updatedBy: null,
            });

            await service.finalizeAssurance('consultation-1', {
                ...finalizeBody(),
                gateDecision: 'FLAG',
                guardrailDecisions: { safety: { decision: 'FLAG' } },
            });

            const [, payload] = assuranceService.publishComplete.mock.calls[0];
            expect(payload.postSignAlert).toBe(true);
            expect(payload.safetyFlag).toBe(true);
        });

        it('still finalizes (verdict backfilled + status flipped) when the assurance publish throws — best-effort', async () => {
            assuranceService.publishComplete.mockRejectedValue(new Error('redis down'));

            await expect(service.finalizeAssurance('consultation-1', finalizeBody())).resolves.toEqual(
                expect.objectContaining({ recorded: true, contextItemId: 'ctx-draft-1' }),
            );
            expect(summaryMetaRepository.update).toHaveBeenCalledTimes(1);
            expect(consultationRepository.update).toHaveBeenCalledWith(
                'consultation-1',
                expect.objectContaining({ status: ConsultationStatus.PENDING_REVIEW }),
            );
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
