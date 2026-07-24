/**
 * HarnessInternalService Unit Tests
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
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConsultationStatus, HarnessAuditAction, ResourceStatusType, SummaryMetaFactory } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';
import { HARNESS_DRAFT_PHASE } from '../dto';

// Mock the domain factories so we can assert on plain-object creation args
// (entity classes store data behind getters, which objectContaining can't see).
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        // `createMany` returns only a row count (Prisma never echoes created
        // rows), so `entityIds` now reads `namedEntity.id` directly off the
        // factory-produced object rather than a per-entity `.create()` return
        // value — the mock id is derived from `text` so it stays
        // per-entity-distinguishable for assertions.
        NamedEntityFactory: {
            CreateNamedEntity: vi.fn((data) => ({ id: `ne-${data.text}`, ...data })),
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
        // Echo the AI-draft v1 snapshot args so the
        // persistDraft snapshot test can assert on the version written.
        ContextItemVersionFactory: {
            CreateFromContextItem: vi.fn((contextItem, versionNumber, changeReason, changedBy, changeSource, changeSummary) => ({
                id: 'ver-temp',
                contextItemId: contextItem.id,
                versionNumber,
                content: contextItem.content,
                changeReason,
                changedBy,
                changeSource: changeSource ?? 'manual',
                changeSummary: changeSummary ?? null,
                tenantId: contextItem.tenantId,
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
    // The live SOAP snapshot lookup; default empty
    // (cold path) so pre-existing assemble/persistDraft tests stay green.
    findPreSummaries: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'ctx-draft-1', content: 'S: ...', tenantId: 'tenant-1' }),
    // Encrypt-on-write helper (declaration-merged sibling): plaintext `content`
    // has no column, so a create that skips this drops the note at rest.
    encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
});

// The AI-draft v1 snapshot sink (best-effort).
const createMockContextItemVersionRepository = () => ({
    create: vi.fn().mockResolvedValue({ id: 'ver-1' }),
    // Encrypt-on-write helper (declaration-merged sibling).
    encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
});

// Mocked SecretsService. encryptBestEffort only checks it is
// truthy and delegates to the repo helper, so a minimal stub suffices.
const createMockSecretsService = () => ({
    encrypt: vi.fn().mockResolvedValue('vault:v1:x'),
    decrypt: vi.fn(),
    getPhiTransitKeyName: () => 'hope-phi',
});

const createMockConsultationRepository = () => ({
    findById: vi.fn().mockResolvedValue({
        id: 'consultation-1',
        tenantId: 'tenant-1',
        departmentId: 'dept-1',
        doctorId: 'doctor-1',
        parentConsultationId: null,
        status: ConsultationStatus.RECORDING,
        updatedBy: null,
        // F-10: write-back paths reject a non-ENABLED consultation. Default
        // fixture is ENABLED (live) so every pre-existing test is unaffected;
        // the F-10 tests override this per-call via mockResolvedValueOnce.
        resourceStatus: ResourceStatusType.ENABLED,
    }),
    update: vi.fn().mockResolvedValue({ id: 'consultation-1' }),
});

const createMockNamedEntityRepository = () => ({
    create: vi.fn().mockImplementation((e) => Promise.resolve({ id: `ne-${e.text}` })),
    // F-14: persistEntities batches every row into ONE createMany call.
    // Prisma's createMany never echoes rows, so the mock mirrors that shape
    // (a row count only) — callers read ids off the pre-generated entities.
    createMany: vi.fn().mockImplementation((entities: unknown[]) => Promise.resolve({ count: entities.length })),
    // Encrypt-on-write helper (declaration-merged sibling).
    encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
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
    // Encrypt-on-write helper (declaration-merged sibling).
    encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
    // FinalizeAssurance backfills the early-persisted meta.
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

// Manual doctor highlights threaded into assemble.
const createMockHighlightRepository = () => ({
    findByConsultation: vi.fn().mockResolvedValue([]),
});

// Warm-start kill-switch. Default OFF (prod default);
// pass `true` to exercise the ON behavior. Mirrors how sibling harness/summary
// services read config (ConfigService.get).
const createMockConfigService = (warmStartEnabled = false) => ({
    get: vi.fn((key: string) =>
        key === 'HARNESS_WARM_START_ENABLED' ? (warmStartEnabled ? 'true' : undefined) : undefined,
    ),
});

// The live assurance feed. finalizeAssurance publishes
// the terminal `assurance_complete` (aggregate verdict + safetyFlag + postSignAlert)
// to close the SSE stream. Best-effort: a publish failure must not break finalize.
const createMockHarnessAssuranceService = () => ({
    reportClaim: vi.fn().mockResolvedValue({ ok: true }),
    publishComplete: vi.fn().mockResolvedValue({ ok: true }),
});

// The realtime ConfigResolver. The harness assemble path
// threads the doctor's preferred prompt id (UserProfile.preferredPromptTemplateId,
// read-only) so async/harness generation honors Tier-0 like the sync/REST path.
const createMockConfigResolver = () => ({
    resolvePreferredPromptTemplateId: vi.fn().mockResolvedValue(null),
    resolvePipelineToggles: vi.fn(),
    // Effective DNA decision (tenant AND doctor). Default
    // effective so existing fixtures (which never pass a dnaStyleId) are unaffected.
    resolveEffectiveDnaStyleEnabled: vi.fn().mockResolvedValue({ effective: true, tenantEnabled: true, doctorToggle: null }),
});

// A real cache-behaving IRedisCacheService stub: an internal
// Map so get returns what a prior setex wrote (so the idempotency guard can
// replay). Optional + trailing in the ctor; unwired in the pre-existing fixtures.
const createMockRedisCache = () => {
    const store = new Map<string, string>();
    return {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        setex: vi.fn(async (key: string, _ttl: number, value: string) => {
            store.set(key, value);
        }),
        isConnected: vi.fn(() => true),
        __store: store,
    };
};

// transcript-segment reader for assemble StrictCitations refs.
const createMockTranscriptSegmentRepository = () => ({
    findByContextItem: vi.fn().mockResolvedValue([]),
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
    let contextItemVersionRepository: ReturnType<typeof createMockContextItemVersionRepository>;
    let secretsService: ReturnType<typeof createMockSecretsService>;

    // (re)build the service with the warm-start flag in a
    // known state. Default OFF mirrors prod; warm-start tests call buildService(true).
    // Optional configResolver (13th arg) so existing fixtures
    // keep their arity; the preferred-prompt threading tests pass one explicitly.
    // Optional contextItemVersionRepository (14th arg) for
    // the AI-draft v1 snapshot; always wired here so persistDraft snapshots.
    // Optional `withSecrets` (default ON) appends the mocked
    // SecretsService as the 15th arg. Pass `false` to exercise the unwired path
    // (encrypt-on-write must no-op and never call the repo helper).
    // Optional `redisCache` (16th arg) so the idempotency-dedup
    // tests wire a real cache-behaving stub; existing fixtures pass 15 args and the
    // trailing @Optional() ctor param stays undefined (dedup no-ops, exact prior path).
    // optional `transcriptSegmentRepository` (17th arg) for assemble
    // segment-citation refs + citationsMap enrichment; unwired ⇒ empty refs.
    // Optional `harnessPolicyService` (18th arg): the effective
    // `warmStartEnabled` authority. Unwired ⇒ the env fallback governs, which is the
    // legacy behaviour every fixture below relies on.
    const buildService = (
        warmStartEnabled = false,
        configResolver?: ReturnType<typeof createMockConfigResolver>,
        withSecrets = true,
        redisCache?: ReturnType<typeof createMockRedisCache>,
        transcriptSegmentRepository?: ReturnType<typeof createMockTranscriptSegmentRepository>,
        harnessPolicyService?: { getEffectivePolicy: ReturnType<typeof vi.fn> },
    ) => {
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
            configResolver as any,
            contextItemVersionRepository as any,
            withSecrets ? (secretsService as any) : undefined,
            redisCache as any,
            transcriptSegmentRepository as any,
            harnessPolicyService as any,
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
        contextItemVersionRepository = createMockContextItemVersionRepository();
        secretsService = createMockSecretsService();

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

            // Batched into ONE createMany call (F-14), not one create() per entity.
            expect(namedEntityRepository.createMany).toHaveBeenCalledTimes(1);
            expect(namedEntityRepository.create).not.toHaveBeenCalled();
            const batch = namedEntityRepository.createMany.mock.calls[0][0];
            expect(batch).toHaveLength(2);
            expect(batch[0]).toEqual(
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

        // (AC-3c) — the harness NER round-trips ontology codes; the
        // DTO → factory mapping now sets the five NamedEntity code columns. RED
        // before the mapping forwards them (they were dropped → columns null).
        it('persists the five ontology codes from the coded HarnessEntityItem', async () => {
            await service.persistEntities('consultation-1', {
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                contextItemId: 'tx-1',
                entities: [
                    {
                        text: 'metformin',
                        type: 'MEDICATION',
                        startOffset: 14,
                        endOffset: 23,
                        confidence: 0.97,
                        umlsCui: 'C0025598',
                        rxnormCode: '6809',
                    },
                ],
            } as any);

            const firstArg = namedEntityRepository.createMany.mock.calls[0][0][0];
            expect(firstArg).toEqual(
                expect.objectContaining({
                    text: 'metformin',
                    className: 'MEDICATION',
                    umlsCui: 'C0025598',
                    rxnormCode: '6809',
                }),
            );
        });

        it('throws BadRequestException and persists nothing when tenantId is missing', async () => {
            await expect(
                service.persistEntities('consultation-1', { tenantId: '', contextItemId: 'tx-1', entities: [] } as any),
            ).rejects.toThrow(BadRequestException);
            expect(namedEntityRepository.createMany).not.toHaveBeenCalled();
        });

        it('cross-tenant tenantId mismatch → NotFoundException (404-over-403), persists nothing', async () => {
            // The consultation belongs to tenant-1 (default fixture); the request claims
            // tenant-OTHER. assertEqualTenants throws NotFoundException (never leaks the
            // resource's real tenant) and no NamedEntity WORM/PHI row is written.
            await expect(
                service.persistEntities('consultation-1', {
                    tenantId: 'tenant-OTHER',
                    userId: 'doctor-1',
                    contextItemId: 'tx-1',
                    entities: [{ text: 'Metformin', type: 'MEDICATION', startOffset: 5, endOffset: 14, confidence: 0.9 }],
                } as any),
            ).rejects.toThrow(NotFoundException);
            expect(namedEntityRepository.createMany).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // getEntities (the read counterpart the harness reuses as
    // NER priors instead of re-extracting cold)
    // =========================================================================

    describe('getEntities', () => {
        it('reads NamedEntity rows and maps them to coded, transcript-offset priors', async () => {
            // A coded row with distinct transcript-span offsets (preferred over source).
            namedEntityRepository.findByConsultation.mockResolvedValue([
                {
                    text: 'metformin',
                    className: 'MEDICATION',
                    normalizedText: 'metformin',
                    startOffset: 14,
                    endOffset: 23,
                    transcriptStartOffset: 40,
                    transcriptEndOffset: 49,
                    umlsCui: 'C0025598',
                    rxnormCode: '6809',
                    snomedCode: null,
                    icdCode: null,
                    loincCode: null,
                },
            ]);

            const result = await service.getEntities('consultation-1', 'tenant-1');

            expect(cls.run).toHaveBeenCalledTimes(1);
            expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
            expect(namedEntityRepository.findByConsultation).toHaveBeenCalledWith('consultation-1');
            expect(result.entities).toEqual([
                expect.objectContaining({
                    text: 'metformin',
                    type: 'MEDICATION', // className -> type
                    normalizedText: 'metformin',
                    startOffset: 40, // transcript-span offset preferred
                    endOffset: 49,
                    umlsCui: 'C0025598',
                    rxnormCode: '6809',
                }),
            ]);
        });

        it('throws BadRequestException when tenantId is missing', async () => {
            await expect(service.getEntities('consultation-1', '')).rejects.toThrow(BadRequestException);
            expect(namedEntityRepository.findByConsultation).not.toHaveBeenCalled();
        });

        it('cross-tenant tenantId mismatch → NotFoundException (404-over-403), reads nothing', async () => {
            await expect(service.getEntities('consultation-1', 'tenant-OTHER')).rejects.toThrow(NotFoundException);
            expect(namedEntityRepository.findByConsultation).not.toHaveBeenCalled();
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

        it('folds case notes, work notes, and attachments into the assembled prompt', async () => {
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

        it('prefers an attachment\'s extracted text over the filename label', async () => {
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

        // F-03: an oversized attachment must not dominate the context window /
        // injection surface — cap the per-attachment fold at 20000 chars with
        // an explicit truncation marker (never silent).
        it('caps an oversized attachment fold at 20000 chars with a truncation marker', async () => {
            const oversized = 'x'.repeat(25_000);
            contextItemRepository.findAttachments.mockResolvedValue([
                { id: 'at-big', metaData: { extractedText: oversized } },
            ]);

            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            const call = (promptAssemblyService.assemble as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
            expect(call.attachments).toHaveLength(1);
            const folded = call.attachments[0] as string;
            expect(folded.length).toBe(20_000 + '…[attachment truncated for context]'.length);
            expect(folded.startsWith('x'.repeat(20_000))).toBe(true);
            expect(folded.endsWith('…[attachment truncated for context]')).toBe(true);
        });

        it('does not truncate an attachment at or under the 20000-char cap', async () => {
            const exact = 'y'.repeat(20_000);
            contextItemRepository.findAttachments.mockResolvedValue([{ id: 'at-exact', content: exact }]);

            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            const call = (promptAssemblyService.assemble as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
            expect(call.attachments[0]).toBe(exact);
        });

        it('folds the doctor\'s manual highlights into the assembled prompt (Workstream B)', async () => {
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

        // ── Effective warm-start policy beats env ──
        // `HarnessPolicy.warmStartEnabled` was write-plumbed to the admin console and
        // read by nothing; the real switch was the env var, cached at construction.
        // Policy is now the authority, resolved per call, env only the null-fallback.
        describe('effective warmStartEnabled', () => {
            const withPolicy = (warmStartEnabled: boolean | null, env = false) => {
                const getEffectivePolicy = vi.fn().mockResolvedValue({ warmStartEnabled });
                const svc = buildService(env, undefined, true, undefined, undefined, { getEffectivePolicy });
                return { service: svc, getEffectivePolicy };
            };

            const SNAPSHOT = {
                id: 'ps-live-1',
                content: 'S: chest pain O: BP 120/80',
                metaData: { subType: 'LIVE_SOAP_SNAPSHOT' },
                createdAt: new Date(),
            };

            const assembledPreSummary = () =>
                (promptAssemblyService.assemble as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].preSummaryText;

            beforeEach(() => {
                contextItemRepository.findPreSummaries.mockResolvedValue([SNAPSHOT]);
            });

            it('policy=false beats env=true → no snapshot lookup, no prior draft', async () => {
                const { service: svc } = withPolicy(false, true);
                await svc.assemble('consultation-1', { tenantId: 'tenant-1' } as any);
                expect(contextItemRepository.findPreSummaries).not.toHaveBeenCalled();
                expect(assembledPreSummary()).toBeUndefined();
            });

            it('policy=true beats env unset → warm start ON', async () => {
                const { service: svc } = withPolicy(true, false);
                await svc.assemble('consultation-1', { tenantId: 'tenant-1' } as any);
                expect(assembledPreSummary()).toBe(SNAPSHOT.content);
            });

            it('policy=null falls back to env (previous behaviour preserved)', async () => {
                const { service: svc } = withPolicy(null, true);
                await svc.assemble('consultation-1', { tenantId: 'tenant-1' } as any);
                expect(assembledPreSummary()).toBe(SNAPSHOT.content);
            });

            it('resolves the policy for the request tenant, per call', async () => {
                const { service: svc, getEffectivePolicy } = withPolicy(true);
                await svc.assemble('consultation-1', { tenantId: 'tenant-1' } as any);
                await svc.assemble('consultation-1', { tenantId: 'tenant-1' } as any);
                expect(getEffectivePolicy).toHaveBeenCalledWith('tenant-1');
                expect(getEffectivePolicy).toHaveBeenCalledTimes(2);
            });

            it('threads the tenant into prompt assembly so both gates agree', async () => {
                const { service: svc } = withPolicy(true);
                await svc.assemble('consultation-1', { tenantId: 'tenant-1' } as any);
                expect(promptAssemblyService.assemble).toHaveBeenCalledWith(
                    expect.objectContaining({ tenantId: 'tenant-1' }),
                );
            });
        });

        // ── Warm-start from the live SOAP snapshot ──
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

        // ── Doctor preferred-prompt threading ──
        // The async/harness assemble path must honor the doctor's preferred prompt
        // (Tier-0) exactly like the sync REST + processor paths. The id is resolved
        // read-only from UserProfile via ConfigResolver, keyed off consultation.doctorId.
        it('threads the doctor preferred prompt id (from consultation.doctorId) into assemble', async () => {
            const configResolver = createMockConfigResolver();
            configResolver.resolvePreferredPromptTemplateId.mockResolvedValue('tpl-doctor-pref');
            service = buildService(false, configResolver);

            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            expect(configResolver.resolvePreferredPromptTemplateId).toHaveBeenCalledWith('doctor-1');
            expect(promptAssemblyService.assemble).toHaveBeenCalledWith(
                expect.objectContaining({ preferredPromptTemplateId: 'tpl-doctor-pref' }),
            );
        });

        it('threads undefined preferred id when no ConfigResolver is wired (back-compat arity)', async () => {
            // Default service is built WITHOUT a ConfigResolver — the preferred id is
            // simply omitted, preserving the exact pre-Phase-5 assemble behavior.
            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            const call = (promptAssemblyService.assemble as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
            expect(call.preferredPromptTemplateId).toBeUndefined();
        });

        it('omits the preferred id when the doctor has no preference (resolver returns null)', async () => {
            const configResolver = createMockConfigResolver();
            configResolver.resolvePreferredPromptTemplateId.mockResolvedValue(null);
            service = buildService(false, configResolver);

            await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            expect(configResolver.resolvePreferredPromptTemplateId).toHaveBeenCalledWith('doctor-1');
            const call = (promptAssemblyService.assemble as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
            expect(call.preferredPromptTemplateId ?? undefined).toBeUndefined();
        });

        // ── DNA-style application gating (tenant AND doctor) ──
        // The harness generation path must apply DNA style only when EFFECTIVE,
        // exactly like the sync SummaryService path, keyed off consultation.doctorId.
        it('applies the requested DNA style on the harness path when effective', async () => {
            const configResolver = createMockConfigResolver();
            configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: true, tenantEnabled: true, doctorToggle: null });
            service = buildService(false, configResolver);

            await service.assemble('consultation-1', { tenantId: 'tenant-1', dnaStyleId: 'dna-1' });

            expect(configResolver.resolveEffectiveDnaStyleEnabled).toHaveBeenCalledWith(
                expect.objectContaining({ tenantId: 'tenant-1', doctorId: 'doctor-1' }),
            );
            const call = (promptAssemblyService.assemble as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
            expect(call.dnaStyleId).toBe('dna-1');
        });

        it('drops the DNA style on the harness path when NOT effective (opted out / tenant off)', async () => {
            const configResolver = createMockConfigResolver();
            configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: false, tenantEnabled: true, doctorToggle: false });
            service = buildService(false, configResolver);

            await service.assemble('consultation-1', { tenantId: 'tenant-1', dnaStyleId: 'dna-1' });

            const call = (promptAssemblyService.assemble as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
            expect(call.dnaStyleId).toBeUndefined();
        });

        // ── PHI-safe segment citation refs on assemble ────────────
        it('returns PHI-safe segmentCitations when a single transcript has segments', async () => {
            const transcriptSegmentRepository = createMockTranscriptSegmentRepository();
            transcriptSegmentRepository.findByContextItem.mockResolvedValue([
                {
                    id: 'seg-a',
                    idx: 0,
                    speaker: 'CLINICIAN',
                    t0Ms: 0,
                    t1Ms: 1200,
                    charStart: 0,
                    charEnd: 20,
                },
                {
                    id: 'seg-b',
                    idx: 1,
                    speaker: 'PATIENT',
                    t0Ms: 1200,
                    t1Ms: 3400,
                    charStart: 20,
                    charEnd: 40,
                },
            ]);
            service = buildService(false, undefined, true, undefined, transcriptSegmentRepository);

            const result = await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            expect(transcriptSegmentRepository.findByContextItem).toHaveBeenCalledWith('tenant-1', 'tx-1');
            expect(result.segmentCitations).toEqual([
                { id: 'seg-a', idx: 0, speaker: 'CLINICIAN', t0Ms: 0, t1Ms: 1200 },
                { id: 'seg-b', idx: 1, speaker: 'PATIENT', t0Ms: 1200, t1Ms: 3400 },
            ]);
            // PHI posture: structural hints only — never char offsets or plaintext.
            for (const ref of result.segmentCitations ?? []) {
                expect(ref).not.toHaveProperty('charStart');
                expect(ref).not.toHaveProperty('charEnd');
                expect(ref).not.toHaveProperty('text');
                expect(ref).not.toHaveProperty('content');
            }
        });

        it('returns empty segmentCitations when consultation has multiple transcripts', async () => {
            contextItemRepository.findTranscripts.mockResolvedValue([
                { id: 'tx-1', content: 'first' },
                { id: 'tx-2', content: 'second' },
            ]);
            const transcriptSegmentRepository = createMockTranscriptSegmentRepository();
            transcriptSegmentRepository.findByContextItem.mockResolvedValue([
                { id: 'seg-a', idx: 0, speaker: 'CLINICIAN', t0Ms: 0, t1Ms: 500 },
            ]);
            service = buildService(false, undefined, true, undefined, transcriptSegmentRepository);

            const result = await service.assemble('consultation-1', { tenantId: 'tenant-1' });

            expect(result.segmentCitations).toEqual([]);
            expect(transcriptSegmentRepository.findByContextItem).not.toHaveBeenCalled();
        });

        it('returns empty segmentCitations when no segments persisted (or repo unwired)', async () => {
            const withEmptyRepo = createMockTranscriptSegmentRepository();
            service = buildService(false, undefined, true, undefined, withEmptyRepo);
            expect((await service.assemble('consultation-1', { tenantId: 'tenant-1' })).segmentCitations).toEqual([]);

            // Unwired (default buildService) — same empty-list contract.
            service = buildService(false);
            expect((await service.assemble('consultation-1', { tenantId: 'tenant-1' })).segmentCitations).toEqual([]);
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

        it('encrypts the draft note content into the ContextItem before persisting', async () => {
            // The plaintext `content` column was dropped in the PHI field-encryption
            // migration — a persistDraft that skips `encryptContentIntoEntity`
            // silently loses the generated clinical note at rest.
            await service.persistDraft('consultation-1', draftBody());

            expect(contextItemRepository.encryptContentIntoEntity).toHaveBeenCalledTimes(1);
            const [entityArg, secretsArg] = contextItemRepository.encryptContentIntoEntity.mock.calls[0];
            expect(entityArg.content).toBe('S: chest pain O: BP 120/80 A: stable P: review');
            expect(secretsArg).toBe(secretsService);
            const encOrder = contextItemRepository.encryptContentIntoEntity.mock.invocationCallOrder[0];
            const createOrder = contextItemRepository.create.mock.invocationCallOrder[0];
            expect(encOrder).toBeLessThan(createOrder);
            expect(contextItemRepository.create.mock.calls[0][0]).toBe(entityArg);
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

        // ── DNA redaction/rewrite audit trail (TASK-551) ──
        it('threads the redaction marker + manifest onto SummaryMeta and encrypts it', async () => {
            const manifest = { applied: true, total_hits: 2, hits_by_rule: { 'r-employer': 2 } };
            await service.persistDraft('consultation-1', {
                ...draftBody(),
                redactionApplied: true,
                redactionManifest: manifest,
            });

            expect(summaryMetaRepository.create).toHaveBeenCalledTimes(1);
            const smArg = summaryMetaRepository.create.mock.calls[0][0];
            expect(smArg).toEqual(
                expect.objectContaining({
                    redactionApplied: true,
                    redactionManifest: manifest,
                }),
            );
            // The manifest must be encrypted-on-write (F-031 guard: a writer that skips
            // the cipher silently drops the audit trail to a plaintext-less row).
            expect(summaryMetaRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
            const encOrder = summaryMetaRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0];
            const createOrder = summaryMetaRepository.create.mock.invocationCallOrder[0];
            expect(encOrder).toBeLessThan(createOrder);
        });

        it('defaults the redaction fields to null when the harness omits them (no redaction ran)', async () => {
            await service.persistDraft('consultation-1', draftBody());
            const smArg = summaryMetaRepository.create.mock.calls[0][0];
            expect(smArg.redactionApplied).toBeNull();
            expect(smArg.redactionManifest).toBeNull();
        });

        // ── [[seg:]] StrictCitations marker lane (write-only fix) ──
        // The model complies and cites `[[seg:<id>]]` in the generated note, but
        // nothing used to strip the raw marker before it reached the clinician-visible
        // ContextItem content, and the cited ids were dropped on the floor instead of
        // feeding `SummaryMeta.citationsMap`.
        describe('[[seg:]] StrictCitations markers', () => {
            it('strips [[seg:<id>]] markers from the persisted note content before encryption', async () => {
                const transcriptSegmentRepository = createMockTranscriptSegmentRepository();
                transcriptSegmentRepository.findByContextItem.mockResolvedValue([
                    { id: 'seg-a', idx: 0, speaker: 'CLINICIAN', t0Ms: 0, t1Ms: 1200, charStart: 0, charEnd: 20 },
                ]);
                service = buildService(false, undefined, true, undefined, transcriptSegmentRepository);

                await service.persistDraft('consultation-1', {
                    ...draftBody(),
                    content: 'Plan: metformin 500mg [[seg:seg-a]] twice daily.',
                });

                const [entityArg] = contextItemRepository.encryptContentIntoEntity.mock.calls[0];
                expect(entityArg.content).toBe('Plan: metformin 500mg twice daily.');
                expect(entityArg.content).not.toMatch(/\[\[seg:/);
            });

            it('merges cited (allowed) segment ids into SummaryMeta.citationsMap.segmentCitedIds', async () => {
                const transcriptSegmentRepository = createMockTranscriptSegmentRepository();
                transcriptSegmentRepository.findByContextItem.mockResolvedValue([
                    { id: 'seg-a', idx: 0, speaker: 'CLINICIAN', t0Ms: 0, t1Ms: 1200, charStart: 0, charEnd: 20 },
                ]);
                service = buildService(false, undefined, true, undefined, transcriptSegmentRepository);

                await service.persistDraft('consultation-1', {
                    ...draftBody(),
                    content: 'Plan: metformin 500mg [[seg:seg-a]] twice daily.',
                });

                const smArg = summaryMetaRepository.create.mock.calls[0][0];
                expect(smArg.citationsMap).toEqual(
                    expect.objectContaining({
                        claims: [{ id: 'c1', status: 'verified' }],
                        segmentCitedIds: ['seg-a'],
                    }),
                );
            });

            it('drops a hallucinated segment id (not a real persisted segment) from citationsMap but still strips it from the note', async () => {
                const transcriptSegmentRepository = createMockTranscriptSegmentRepository();
                transcriptSegmentRepository.findByContextItem.mockResolvedValue([
                    { id: 'seg-a', idx: 0, speaker: 'CLINICIAN', t0Ms: 0, t1Ms: 1200, charStart: 0, charEnd: 20 },
                ]);
                service = buildService(false, undefined, true, undefined, transcriptSegmentRepository);

                await service.persistDraft('consultation-1', {
                    ...draftBody(),
                    content: 'Plan: [[seg:not-a-real-segment]] metformin.',
                });

                const [entityArg] = contextItemRepository.encryptContentIntoEntity.mock.calls[0];
                expect(entityArg.content).toBe('Plan: metformin.');
                const smArg = summaryMetaRepository.create.mock.calls[0][0];
                expect(smArg.citationsMap).toEqual({ claims: [{ id: 'c1', status: 'verified' }] });
            });

            it('leaves content and citationsMap untouched when no markers are present', async () => {
                await service.persistDraft('consultation-1', draftBody());

                const [entityArg] = contextItemRepository.encryptContentIntoEntity.mock.calls[0];
                expect(entityArg.content).toBe('S: chest pain O: BP 120/80 A: stable P: review');
                const smArg = summaryMetaRepository.create.mock.calls[0][0];
                expect(smArg.citationsMap).toEqual({ claims: [{ id: 'c1', status: 'verified' }] });
            });

            it('still strips markers from content even when the transcript-segment repository is unwired (best-effort citationsMap merge only)', async () => {
                // Default buildService() — no transcriptSegmentRepository wired.
                await service.persistDraft('consultation-1', {
                    ...draftBody(),
                    content: 'Plan: [[seg:seg-a]] metformin.',
                });

                const [entityArg] = contextItemRepository.encryptContentIntoEntity.mock.calls[0];
                expect(entityArg.content).toBe('Plan: metformin.');
            });
        });

        // ── AI-draft v1 snapshot ──
        it('captures an ai_draft_v1 ContextItemVersion (v1, ai_model) and pins the draft to currentVersionNumber=1', async () => {
            await service.persistDraft('consultation-1', draftBody());

            expect(contextItemVersionRepository.create).toHaveBeenCalledTimes(1);
            const version = contextItemVersionRepository.create.mock.calls[0][0];
            expect(version.versionNumber).toBe(1);
            expect(version.changeReason).toBe('ai_draft_v1');
            expect(version.changeSource).toBe('ai_model');

            // The RAW_SUMMARY context item is pinned to v1 so the first edit is v2.
            const createdItem = contextItemRepository.create.mock.calls[0][0];
            expect(createdItem.currentVersionNumber).toBe(1);
        });

        it('still persists the draft when the best-effort v1 snapshot write throws', async () => {
            contextItemVersionRepository.create.mockRejectedValueOnce(new Error('db down'));

            const result = await service.persistDraft('consultation-1', draftBody());

            expect(result).toEqual({ contextItemId: 'ctx-draft-1' });
            expect(summaryMetaRepository.create).toHaveBeenCalledTimes(1);
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

        // ── Warm-start provenance ──
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
    // persistDraft — early delivery (DRAFT_PENDING_SENSORS)
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

        // ── [[seg:]] StrictCitations markers survive the EARLY withhold ──
        // The verdict citationsMap (dto.citationsMap, NER claims) is correctly
        // withheld in the early phase, but `[[seg:]]` marker validation happens
        // against the note content (already available at EARLY persist time) —
        // those cited ids must not be dropped on the floor; finalizeAssurance needs
        // them later to merge into the final citationsMap.
        it('carries segmentCitedIds (only) into the withheld citationsMap when the note cites real segments', async () => {
            const transcriptSegmentRepository = createMockTranscriptSegmentRepository();
            transcriptSegmentRepository.findByContextItem.mockResolvedValue([
                { id: 'seg-a', idx: 0, speaker: 'CLINICIAN', t0Ms: 0, t1Ms: 1200, charStart: 0, charEnd: 20 },
            ]);
            service = buildService(false, undefined, true, undefined, transcriptSegmentRepository);

            await service.persistDraft('consultation-1', {
                ...earlyBody(),
                content: 'Plan: metformin 500mg [[seg:seg-a]] twice daily.',
            });

            const smArg = summaryMetaRepository.create.mock.calls[0][0];
            expect(smArg.citationsMap).toEqual({ segmentCitedIds: ['seg-a'] });
        });

        it('still withholds citationsMap (null) in the early phase when no markers are present', async () => {
            await service.persistDraft('consultation-1', earlyBody());
            const smArg = summaryMetaRepository.create.mock.calls[0][0];
            expect(smArg.citationsMap).toBeNull();
        });
    });

    // =========================================================================
    // finalizeAssurance — second phase
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
                resourceStatus: ResourceStatusType.ENABLED,
            });
        });

        // ── EARLY-path [[seg:]] segmentCitedIds must survive into the finalized citationsMap ──
        // persistDraft's EARLY phase withholds the verdict citationsMap but still carries
        // forward any `[[seg:]]`-cited (and validated) segment ids on the early-persisted
        // SummaryMeta (`{ segmentCitedIds: [...] }`). finalizeAssurance backfills the real
        // verdict citationsMap and must MERGE that early segmentCitedIds in rather than
        // overwrite/drop it — mirroring the LEGACY (single-shot) merge in persistDraft.
        it('merges the EARLY-persisted segmentCitedIds into the finalized citationsMap', async () => {
            summaryMetaRepository.findByContextItem.mockResolvedValue({
                id: 'sm-early-1',
                contextItemId: 'ctx-draft-1',
                ragTriadScore: null,
                citationsMap: { segmentCitedIds: ['seg-a'] },
                guardrailDecisions: null,
                gateDecision: null,
                assuranceCompletedAt: null,
            });

            await service.finalizeAssurance('consultation-1', finalizeBody());

            const [, updated] = summaryMetaRepository.update.mock.calls[0];
            expect(updated.citationsMap).toEqual(
                expect.objectContaining({
                    claims: [{ id: 'c1', status: 'verified' }],
                    segmentCitedIds: ['seg-a'],
                }),
            );
        });

        it('leaves citationsMap as the fresh verdict map when no EARLY segmentCitedIds exist', async () => {
            // Default beforeEach mock: early meta citationsMap is null.
            await service.finalizeAssurance('consultation-1', finalizeBody());
            const [, updated] = summaryMetaRepository.update.mock.calls[0];
            expect(updated.citationsMap).toEqual({ claims: [{ id: 'c1', status: 'verified' }] });
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
                resourceStatus: ResourceStatusType.ENABLED,
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

        it('records POST_SIGN_FLAG and does NOT regress status when a safety FLAG lands after an early sign', async () => {
            consultationRepository.findById.mockResolvedValue({
                id: 'consultation-1',
                tenantId: 'tenant-1',
                status: ConsultationStatus.SIGNED,
                updatedBy: null,
                resourceStatus: ResourceStatusType.ENABLED,
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

        it('records POST_SIGN_FLAG for a REGEN verdict after an early sign', async () => {
            consultationRepository.findById.mockResolvedValue({
                id: 'consultation-1',
                tenantId: 'tenant-1',
                status: ConsultationStatus.SIGNED,
                updatedBy: null,
                resourceStatus: ResourceStatusType.ENABLED,
            });

            await service.finalizeAssurance('consultation-1', { ...finalizeBody(), gateDecision: 'REGEN' });

            const actions = harnessAuditService.append.mock.calls.map((c: any[]) => c[0].action);
            expect(actions).toContain(HarnessAuditAction.POST_SIGN_FLAG);
        });

        it('does NOT record POST_SIGN_FLAG when the post-sign verdict is PASS', async () => {
            consultationRepository.findById.mockResolvedValue({
                id: 'consultation-1',
                tenantId: 'tenant-1',
                status: ConsultationStatus.SIGNED,
                updatedBy: null,
                resourceStatus: ResourceStatusType.ENABLED,
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
        // Terminal `assurance_complete` published to the SSE feed.
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

        it('publishes postSignAlert: true when an adverse verdict lands AFTER an early sign', async () => {
            consultationRepository.findById.mockResolvedValue({
                id: 'consultation-1',
                tenantId: 'tenant-1',
                status: ConsultationStatus.SIGNED,
                updatedBy: null,
                resourceStatus: ResourceStatusType.ENABLED,
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

        it('cross-tenant tenantId mismatch → NotFoundException (404-over-403), records nothing', async () => {
            // The consultation belongs to tenant-1 (default fixture); the request claims
            // tenant-OTHER. assertEqualTenants throws NotFoundException and no WORM row is written.
            await expect(
                service.recordGateDecision('consultation-1', { ...gateBody(), tenantId: 'tenant-OTHER' }),
            ).rejects.toThrow(NotFoundException);
            expect(harnessAuditService.append).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // recordEscalation — gate SLA-breach escalation record.
    //
    // The harness `escalate_gate` activity POSTs {tenantId, reason, jobId?}; the
    // reason encodes terminal-ness (gate_sla_abandoned = terminal abandon).
    // apps/api persists it as a WORM audit event, mapping the reason to the
    // GATE_ESCALATED / GATE_ABANDONED action, and honours 404-over-403 on a
    // cross-tenant consultation.
    // =========================================================================

    describe('recordEscalation', () => {
        // The harness escalate_gate SLA timeout carries no clinician — {tenantId, reason, jobId?}.
        const escBody = (reason = 'gate_sla_breached', tenantId = 'tenant-1') => ({
            tenantId,
            reason,
            jobId: 'harness-doc-1',
        });

        it('gate_sla_breached → GATE_ESCALATED WORM append, re-establishes CLS, returns { recorded: true }', async () => {
            const result = await service.recordEscalation('consultation-1', escBody('gate_sla_breached'));

            expect(cls.run).toHaveBeenCalledTimes(1);
            expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');

            expect(harnessAuditService.append).toHaveBeenCalledTimes(1);
            const event = harnessAuditService.append.mock.calls[0][0];
            expect(event).toEqual(
                expect.objectContaining({
                    tenantId: 'tenant-1',
                    consultationId: 'consultation-1',
                    action: HarnessAuditAction.GATE_ESCALATED,
                }),
            );

            expect(result).toEqual({ recorded: true });
        });

        it('gate_sla_abandoned → GATE_ABANDONED (terminal) WORM append, returns { recorded: true }', async () => {
            const result = await service.recordEscalation('consultation-1', escBody('gate_sla_abandoned'));

            expect(harnessAuditService.append).toHaveBeenCalledTimes(1);
            expect(harnessAuditService.append.mock.calls[0][0].action).toBe(HarnessAuditAction.GATE_ABANDONED);
            expect(result).toEqual({ recorded: true });
        });

        it('throws BadRequestException and records nothing when tenantId is missing', async () => {
            await expect(
                service.recordEscalation('consultation-1', { reason: 'gate_sla_breached' } as any),
            ).rejects.toThrow(BadRequestException);
            expect(harnessAuditService.append).not.toHaveBeenCalled();
        });

        it('cross-tenant tenantId mismatch → NotFoundException (404-over-403), records nothing', async () => {
            // The consultation belongs to tenant-1 (default fixture); the request claims
            // tenant-OTHER. assertEqualTenants throws NotFoundException (never leaks the
            // resource's real tenant) and no WORM record is written.
            await expect(
                service.recordEscalation('consultation-1', escBody('gate_sla_breached', 'tenant-OTHER')),
            ).rejects.toThrow(NotFoundException);
            expect(harnessAuditService.append).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Idempotency-Key dedup
    //
    // The 4 WORM/state-mutating callbacks re-append on each Temporal retry today.
    // The harness now sends a deterministic Idempotency-Key ({run_id}:{activity_id});
    // apps/api caches-and-replays the prior RESPONSE BODY so a retried callback with
    // the SAME key is exactly one effect. A DIFFERENT/ABSENT key is not suppressed;
    // a Redis throw falls through to normal processing (best-effort, mirrors the consultation-job dedup).
    // =========================================================================

    describe('Idempotency-Key dedup', () => {
        let redisCache: ReturnType<typeof createMockRedisCache>;

        beforeEach(() => {
            redisCache = createMockRedisCache();
            service = buildService(false, undefined, true, redisCache);
        });

        const draftBody = () => ({
            tenantId: 'tenant-1',
            userId: 'doctor-1',
            content: 'S: chest pain O: BP 120/80 A: stable P: review',
            modelName: 'gpt-x',
            modelVersion: 'v9',
        });
        const entitiesBody = () => ({
            tenantId: 'tenant-1',
            userId: 'doctor-1',
            contextItemId: 'tx-1',
            entities: [{ text: 'Metformin', type: 'MEDICATION' }],
        });
        const gateBody = () => ({ tenantId: 'tenant-1', userId: 'doctor-1', gateDecision: 'PASS' });
        const finalizeBody = () => ({ tenantId: 'tenant-1', userId: 'doctor-1', contextItemId: 'ctx-draft-1', gateDecision: 'PASS' });

        it('persistDraft: SAME key twice → ONE ContextItem create + identical cached replay', async () => {
            const first = await service.persistDraft('consultation-1', draftBody() as any, 'run-1:persist_draft');
            const second = await service.persistDraft('consultation-1', draftBody() as any, 'run-1:persist_draft');

            expect(contextItemRepository.create).toHaveBeenCalledTimes(1);
            expect(second).toEqual(first);
            expect(second).toEqual({ contextItemId: 'ctx-draft-1' });
        });

        it('persistDraft: DIFFERENT key → NOT suppressed (create twice)', async () => {
            await service.persistDraft('consultation-1', draftBody() as any, 'run-1:persist_draft');
            await service.persistDraft('consultation-1', draftBody() as any, 'run-2:persist_draft');
            expect(contextItemRepository.create).toHaveBeenCalledTimes(2);
        });

        it('persistDraft: ABSENT key → NOT suppressed (create twice)', async () => {
            await service.persistDraft('consultation-1', draftBody() as any);
            await service.persistDraft('consultation-1', draftBody() as any);
            expect(contextItemRepository.create).toHaveBeenCalledTimes(2);
        });

        it('persistDraft: Redis get throws → falls through and still processes (best-effort)', async () => {
            redisCache.get.mockRejectedValueOnce(new Error('redis down'));
            const result = await service.persistDraft('consultation-1', draftBody() as any, 'run-1:persist_draft');
            expect(contextItemRepository.create).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ contextItemId: 'ctx-draft-1' });
        });

        it('persistDraft: records the key only AFTER a successful write (get-then-setex)', async () => {
            await service.persistDraft('consultation-1', draftBody() as any, 'run-1:persist_draft');
            expect(redisCache.setex).toHaveBeenCalledTimes(1);
            const [key, ttl, value] = redisCache.setex.mock.calls[0];
            expect(key).toContain('idempotency:');
            expect(ttl).toBe(86400);
            expect(JSON.parse(value)).toEqual({ contextItemId: 'ctx-draft-1' });
        });

        it('recordGateDecision: SAME key twice → ONE WORM append + identical replay', async () => {
            const first = await service.recordGateDecision('consultation-1', gateBody() as any, 'run-1:record_gate_decision');
            const second = await service.recordGateDecision('consultation-1', gateBody() as any, 'run-1:record_gate_decision');

            expect(harnessAuditService.append).toHaveBeenCalledTimes(1);
            expect(second).toEqual(first);
            expect(second).toEqual({ recorded: true });
        });

        it('persistEntities: SAME key twice → ONE NamedEntity create batch', async () => {
            await service.persistEntities('consultation-1', entitiesBody() as any, 'run-1:persist_entities');
            await service.persistEntities('consultation-1', entitiesBody() as any, 'run-1:persist_entities');
            expect(namedEntityRepository.createMany).toHaveBeenCalledTimes(1);
        });

        it('finalizeAssurance: SAME key twice → ONE SummaryMeta update + identical replay', async () => {
            const first = await service.finalizeAssurance('consultation-1', finalizeBody() as any, 'run-1:finalize_assurance');
            const second = await service.finalizeAssurance('consultation-1', finalizeBody() as any, 'run-1:finalize_assurance');

            expect(summaryMetaRepository.update).toHaveBeenCalledTimes(1);
            expect(second).toEqual(first);
            expect(second).toEqual({ recorded: true, contextItemId: 'ctx-draft-1' });
        });

        // The harness ships + tests an Idempotency-Key on the
        // escalation POST too, so a re-delivered escalate_gate (worker restart / SLA
        // timeout racing a slow-but-successful POST) must not double-append the
        // hash-chained GATE_ESCALATED / terminal GATE_ABANDONED WORM row. The key
        // ({run_id}:{activity_id}) is stable across retries but unique per distinct
        // escalation tick, so dedup suppresses retries WITHOUT collapsing distinct ticks.
        const escBody = (reason = 'gate_sla_breached') => ({ tenantId: 'tenant-1', reason, jobId: 'harness-doc-1' });

        it('recordEscalation: SAME key twice → ONE WORM append + identical replay', async () => {
            const first = await service.recordEscalation('consultation-1', escBody('gate_sla_abandoned') as any, 'run-1:escalate_gate');
            const second = await service.recordEscalation('consultation-1', escBody('gate_sla_abandoned') as any, 'run-1:escalate_gate');

            expect(harnessAuditService.append).toHaveBeenCalledTimes(1);
            expect(harnessAuditService.append.mock.calls[0][0].action).toBe(HarnessAuditAction.GATE_ABANDONED);
            expect(second).toEqual(first);
            expect(second).toEqual({ recorded: true });
        });

        it('recordEscalation: DIFFERENT key → NOT suppressed (distinct escalation ticks each append)', async () => {
            await service.recordEscalation('consultation-1', escBody() as any, 'run-1:escalate_gate:1');
            await service.recordEscalation('consultation-1', escBody() as any, 'run-1:escalate_gate:2');
            expect(harnessAuditService.append).toHaveBeenCalledTimes(2);
        });

        it('recordEscalation: ABSENT key → NOT suppressed (each append)', async () => {
            await service.recordEscalation('consultation-1', escBody() as any);
            await service.recordEscalation('consultation-1', escBody() as any);
            expect(harnessAuditService.append).toHaveBeenCalledTimes(2);
        });

        it('recordEscalation: Redis get throws → falls through and still appends (best-effort)', async () => {
            redisCache.get.mockRejectedValueOnce(new Error('redis down'));
            const result = await service.recordEscalation('consultation-1', escBody() as any, 'run-1:escalate_gate');
            expect(harnessAuditService.append).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ recorded: true });
        });
    });

    // =========================================================================
    // Field encryption (encrypt-on-write)
    //
    // The harness callback half persists NamedEntity (persistEntities),
    // SummaryMeta (persistDraft create + finalizeAssurance update), and the
    // ai_draft_v1 ContextItemVersion (persistDraft → captureAiDraftSnapshot).
    // Each must encrypt the PHI fields via the repo's encryptFieldsIntoEntity
    // BEFORE persisting, be best-effort during the dual-write soak, and no-op
    // when SecretsService is unwired. The WORM audit payloads are DTO-derived
    // (never the encrypted entity), so there is no ciphertext to strip.
    // =========================================================================

    describe('field encryption', () => {
        const draftBody = () => ({
            tenantId: 'tenant-1',
            userId: 'doctor-1',
            content: 'S: chest pain O: BP 120/80 A: stable P: review',
            modelName: 'gpt-x',
            modelVersion: 'v9',
            citationsMap: { claims: [{ id: 'c1', status: 'verified' }] },
            guardrailDecisions: { safety: { verdict: 'pass' } },
            gateDecision: 'PASS',
        });
        const finalizeBody = () => ({
            tenantId: 'tenant-1',
            userId: 'doctor-1',
            contextItemId: 'ctx-draft-1',
            ragTriadScore: 0.92,
            citationsMap: { claims: [{ id: 'c1', status: 'verified' }] },
            guardrailDecisions: { safety: { verdict: 'pass' } },
            gateDecision: 'PASS',
            modelName: 'gpt-x',
            modelVersion: 'v9',
        });

        // ── NamedEntity (persistEntities) ──
        it('persistEntities encrypts each NamedEntity via encryptFieldsIntoEntity BEFORE the batched createMany', async () => {
            await service.persistEntities('consultation-1', {
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                contextItemId: 'tx-1',
                entities: [
                    { text: 'Metformin', type: 'MEDICATION', startOffset: 5, endOffset: 14, confidence: 0.9 },
                    { text: 'Diabetes', type: 'CONDITION', startOffset: 20, endOffset: 28 },
                ],
            } as any);

            expect(namedEntityRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(2);
            expect(namedEntityRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(
                expect.objectContaining({ text: 'Metformin', className: 'MEDICATION' }),
                secretsService,
            );
            // Both rows are encrypted BEFORE the single batched createMany call
            // (F-14 — encrypt all rows first, then one batch).
            expect(namedEntityRepository.createMany).toHaveBeenCalledTimes(1);
            expect(namedEntityRepository.createMany.mock.calls[0][0]).toHaveLength(2);
            const encOrder = namedEntityRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[1];
            const createOrder = namedEntityRepository.createMany.mock.invocationCallOrder[0];
            expect(encOrder).toBeLessThan(createOrder);
        });

        it('persistEntities is best-effort: a Vault failure does NOT abort the write', async () => {
            namedEntityRepository.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));

            const result = await service.persistEntities('consultation-1', {
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                contextItemId: 'tx-1',
                entities: [{ text: 'Metformin', type: 'MEDICATION' }],
            } as any);

            expect(result.savedCount).toBe(1);
            expect(namedEntityRepository.createMany).toHaveBeenCalledTimes(1);
        });

        it('persistEntities does NOT encrypt when no SecretsService is wired (no-op)', async () => {
            service = buildService(false, undefined, false);

            await service.persistEntities('consultation-1', {
                tenantId: 'tenant-1',
                userId: 'doctor-1',
                contextItemId: 'tx-1',
                entities: [{ text: 'Metformin', type: 'MEDICATION' }],
            } as any);

            expect(namedEntityRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
            expect(namedEntityRepository.createMany).toHaveBeenCalledTimes(1);
        });

        // ── SummaryMeta (persistDraft create) ──
        it('persistDraft encrypts SummaryMeta via encryptFieldsIntoEntity BEFORE create', async () => {
            await service.persistDraft('consultation-1', draftBody() as any);

            expect(summaryMetaRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
            expect(summaryMetaRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'sm-temp' }),
                secretsService,
            );
            const encOrder = summaryMetaRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0];
            const createOrder = summaryMetaRepository.create.mock.invocationCallOrder[0];
            expect(encOrder).toBeLessThan(createOrder);
        });

        // ── ContextItemVersion (persistDraft → captureAiDraftSnapshot) ──
        it('persistDraft encrypts the ai_draft_v1 ContextItemVersion BEFORE create', async () => {
            await service.persistDraft('consultation-1', draftBody() as any);

            expect(contextItemVersionRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
            expect(contextItemVersionRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(
                expect.objectContaining({ changeReason: 'ai_draft_v1' }),
                secretsService,
            );
            const encOrder = contextItemVersionRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0];
            const createOrder = contextItemVersionRepository.create.mock.invocationCallOrder[0];
            expect(encOrder).toBeLessThan(createOrder);
        });

        it('persistDraft skips ALL encryption when no SecretsService is wired (no-op)', async () => {
            service = buildService(false, undefined, false);

            await service.persistDraft('consultation-1', draftBody() as any);

            expect(summaryMetaRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
            expect(contextItemVersionRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
            expect(summaryMetaRepository.create).toHaveBeenCalledTimes(1);
        });

        // ── SummaryMeta (finalizeAssurance update — where the verdict JSONB blobs
        //    actually get their values in the two-phase EARLY flow) ──
        it('finalizeAssurance re-encrypts the backfilled SummaryMeta BEFORE update', async () => {
            consultationRepository.findById.mockResolvedValue({
                id: 'consultation-1',
                tenantId: 'tenant-1',
                status: ConsultationStatus.DRAFT_PENDING_SENSORS,
                updatedBy: null,
                resourceStatus: ResourceStatusType.ENABLED,
            });

            await service.finalizeAssurance('consultation-1', finalizeBody() as any);

            expect(summaryMetaRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
            // The encrypted entity carries the freshly backfilled verdict blobs.
            expect(summaryMetaRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(
                expect.objectContaining({ citationsMap: { claims: [{ id: 'c1', status: 'verified' }] } }),
                secretsService,
            );
            const encOrder = summaryMetaRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0];
            const updateOrder = summaryMetaRepository.update.mock.invocationCallOrder[0];
            expect(encOrder).toBeLessThan(updateOrder);
        });

        it('finalizeAssurance is best-effort: a Vault failure does NOT abort the finalize', async () => {
            consultationRepository.findById.mockResolvedValue({
                id: 'consultation-1',
                tenantId: 'tenant-1',
                status: ConsultationStatus.DRAFT_PENDING_SENSORS,
                updatedBy: null,
                resourceStatus: ResourceStatusType.ENABLED,
            });
            summaryMetaRepository.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));

            const result = await service.finalizeAssurance('consultation-1', finalizeBody() as any);

            expect(result).toEqual(expect.objectContaining({ recorded: true }));
            expect(summaryMetaRepository.update).toHaveBeenCalledTimes(1);
        });

        // ── Required mode (SECRETS_PROVIDER=vault) — FAIL-CLOSED ──
        // The identical encrypt path that is soft (best-effort) above MUST instead
        // abort the write — throw, never persist plaintext-only — once encryption
        // is environment-required. Env is restored in finally so it cannot leak.
        it('persistEntities FAILS CLOSED in required mode: a Vault failure aborts the write', async () => {
            const prevProvider = process.env.SECRETS_PROVIDER;
            process.env.SECRETS_PROVIDER = 'vault';
            try {
                namedEntityRepository.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('transit/encrypt 503'));

                await expect(
                    service.persistEntities('consultation-1', {
                        tenantId: 'tenant-1',
                        userId: 'doctor-1',
                        contextItemId: 'tx-1',
                        entities: [{ text: 'Metformin', type: 'MEDICATION' }],
                    } as any),
                ).rejects.toThrow('transit/encrypt 503');

                // fail-closed: the PHI row must NOT be persisted plaintext-only.
                expect(namedEntityRepository.createMany).not.toHaveBeenCalled();
            } finally {
                if (prevProvider === undefined) delete process.env.SECRETS_PROVIDER;
                else process.env.SECRETS_PROVIDER = prevProvider;
            }
        });
    });

    // =========================================================================
    // F-10: harness write-back paths must reject a non-ENABLED consultation
    // (soft-deleted/disabled/suspended/archived). `findById` + `assertEqualTenants`
    // only guard tenant ownership — an in-flight durable workflow could otherwise
    // keep writing drafts/entities/audit rows to a note the tenant already
    // removed. 404-over-403 preserved: NotFoundException, never a 403.
    // =========================================================================
    describe('F-10: write-back rejects a non-ENABLED consultation', () => {
        const deadConsultation = () => ({
            id: 'consultation-1',
            tenantId: 'tenant-1',
            departmentId: 'dept-1',
            doctorId: 'doctor-1',
            parentConsultationId: null,
            status: ConsultationStatus.PENDING_REVIEW,
            updatedBy: null,
            resourceStatus: ResourceStatusType.DELETED,
        });

        it('persistEntities → 404, no NamedEntity written', async () => {
            consultationRepository.findById.mockResolvedValueOnce(deadConsultation());

            await expect(
                service.persistEntities('consultation-1', {
                    tenantId: 'tenant-1',
                    contextItemId: 'tx-1',
                    entities: [{ text: 'Metformin', type: 'MEDICATION' }],
                } as any),
            ).rejects.toThrow(NotFoundException);
            expect(namedEntityRepository.createMany).not.toHaveBeenCalled();
        });

        it('persistDraft → 404, no ContextItem/SummaryMeta written', async () => {
            consultationRepository.findById.mockResolvedValueOnce(deadConsultation());

            await expect(
                service.persistDraft('consultation-1', {
                    tenantId: 'tenant-1',
                    content: 'S: chest pain O: BP 120/80 A: stable P: review',
                } as any),
            ).rejects.toThrow(NotFoundException);
            expect(contextItemRepository.create).not.toHaveBeenCalled();
            expect(summaryMetaRepository.create).not.toHaveBeenCalled();
        });

        it('finalizeAssurance → 404, no SummaryMeta update', async () => {
            consultationRepository.findById.mockResolvedValueOnce(deadConsultation());

            await expect(
                service.finalizeAssurance('consultation-1', {
                    tenantId: 'tenant-1',
                    contextItemId: 'ctx-draft-1',
                    gateDecision: 'PASS',
                } as any),
            ).rejects.toThrow(NotFoundException);
            expect(summaryMetaRepository.update).not.toHaveBeenCalled();
        });

        it('recordGateDecision → 404, no WORM append', async () => {
            consultationRepository.findById.mockResolvedValueOnce(deadConsultation());

            await expect(
                service.recordGateDecision('consultation-1', { tenantId: 'tenant-1', gateDecision: 'PASS' } as any),
            ).rejects.toThrow(NotFoundException);
            expect(harnessAuditService.append).not.toHaveBeenCalled();
        });

        it('recordEscalation → 404, no WORM append', async () => {
            consultationRepository.findById.mockResolvedValueOnce(deadConsultation());

            await expect(
                service.recordEscalation('consultation-1', { tenantId: 'tenant-1', reason: 'gate_sla_abandoned' } as any),
            ).rejects.toThrow(NotFoundException);
            expect(harnessAuditService.append).not.toHaveBeenCalled();
        });

        // getEntities/assemble are READ paths, deliberately out of scope for F-10
        // (only the write-back paths listed above guard resourceStatus).
    });
});
