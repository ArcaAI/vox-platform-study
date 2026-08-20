/**
 * SummaryService Unit Tests — extractEntities
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
import {
  SysEventType,
  ContextItemVersionFactory,
  HarnessAuditAction,
  ConsultationStatus,
  NamedEntityFactory,
  ConsultationEntity,
} from '@arcaai/domains';

/**
 * TASK-711 — `approveSummary` now calls the REAL
 * `ConsultationEntity.transitionTo` (state-machine.md §2), so every
 * `mockConsultationRepository.findById` fixture must be a real entity
 * instance, not a duck-typed object. Defaults `status` to `PENDING_REVIEW`
 * (a legal predecessor of `SIGNED`) since most of this file's fixtures
 * predate the state machine and never specified one; call sites that need a
 * different predecessor (or a non-signing codepath) pass `status` explicitly.
 */
function consultationFixture(overrides: Record<string, unknown> = {}): ConsultationEntity {
  return new ConsultationEntity({
    id: 'c-1',
    tenantId: 'tenant-1',
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-01-01'),
    metadata: null,
    status: ConsultationStatus.PENDING_REVIEW,
    degradedReasons: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    createdBy: 'user-1',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    version: 1,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

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
      CreateFromContextItem: vi.fn((contextItem, versionNumber, changeReason, changedBy, changeSource, changeSummary) => ({
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
      })),
      // Attested SIGNED_NOTE version used by approveSummary.
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
  // Bare passthrough — only exercised by resolveNerModelInjection's
  // SYSTEM-pin nested scope; every other codepath in this
  // suite never calls `run`.
  run: vi.fn((callback: () => unknown) => callback()),
});

const createMockEventEmitter = () => ({
  emit: vi.fn(),
});

const createMockContextItemRepository = () => {
  const update = vi.fn();
  return {
    findById: vi.fn(),
    findCaseNotes: vi.fn(),
    findTranscripts: vi.fn(),
    findSummaries: vi.fn(),
    findLatestModifiedSummary: vi.fn(),
    findLatestRawSummary: vi.fn(),
    findLatestPreSummary: vi.fn(),
    findLatestPreSummaryWithDecryptedContent: vi.fn().mockResolvedValue({ entity: null, plaintext: null }),
    create: vi.fn(),
    update,
    // TASK-709: `updateSummary`/`approveSummary` now call the OCC-aware
    // Compare-And-Set variant. Delegate to `update` so every pre-existing
    // `.update.mockResolvedValue(...)` / `.mockImplementation(...)`
    // configuration in this suite keeps driving behavior unchanged; the CAS
    // predicate itself (the `expectedVersion` argument) is asserted directly
    // against `updateWithVersion.mock.calls` in the dedicated OCC tests.
    updateWithVersion: vi.fn((id: string, entity: unknown, _expectedVersion?: number, _tx?: unknown) => update(id, entity)),
    encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
};

const createMockConsultationRepository = () => {
  const update = vi.fn();
  return {
    findById: vi.fn(),
    update,
    // TASK-709: `approveSummary` now CASes the Consultation row too (see
    // `createMockContextItemRepository` above for why this delegates).
    updateWithVersion: vi.fn((id: string, entity: unknown, _expectedVersion?: number, _tx?: unknown) => update(id, entity)),
  };
};

// Phase-0 WORM audit service (attestation gate).
const createMockHarnessAuditService = () => ({
  append: vi.fn().mockResolvedValue({ id: 'audit-evt-1' }),
});

// Outbound harness gate adapter. approveSummary
// forwards the sign-off to the harness best-effort (after the WORM write).
const createMockHarnessGatewayService = () => ({
  start: vi.fn().mockResolvedValue({ workflowId: 'wf-1' }),
  signalApproval: vi.fn().mockResolvedValue({ ok: true }),
  // updateSummary forwards a clinician edit of an
  // optimistically-delivered draft to the harness best-effort.
  signalEdit: vi.fn().mockResolvedValue({ ok: true }),
});

const createMockSummaryMetaRepository = () => ({
  create: vi.fn(),
  // The sign-off assurance guard reads the draft's meta.
  // Default null = no harness assurance meta = guard is a no-op (legacy/manual
  // summaries sign through unchanged).
  findByContextItem: vi.fn().mockResolvedValue(null),
  encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
});

const createMockNamedEntityRepository = () => ({
  create: vi.fn(),
});

const createMockContextItemVersionRepository = () => ({
  create: vi.fn(),
  findById: vi.fn(),
  getVersionsByChangeReason: vi.fn().mockResolvedValue([]),
  encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
});

const createMockHttpService = () => ({
  axiosRef: {
    post: vi.fn(),
  },
});

const createMockConfigService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'TEXT_URL') return 'http://localhost:8862';
    if (key === 'NLP_URL') return 'http://localhost:8864';
    return undefined;
  }),
});

const createMockPromptAssemblyService = () => ({
  assemble: vi.fn().mockImplementation((params: { transcript?: string }) =>
    Promise.resolve({
      userPrompt: params.transcript ?? 'assembled prompt text',
      systemPrompt: '',
      hyperparameters: {},
      responseFormat: null,
      resolvedFrom: 'default',
    }),
  ),
});

// Helper to create mock context item
const createMockContextItem = (
  overrides: Partial<{
    id: string;
    tenantId: string;
    consultationId: string;
    type: string;
    content: string | null;
    isSummary: boolean;
    currentVersionNumber: number | null;
    updatedBy: string | null;
  }> = {},
) => ({
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
  // The fail-closed TEXT-selection seam every caller funnels through.
  let mockHarnessPolicyService: { resolveTextSelection: ReturnType<typeof vi.fn> };

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
      resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'resolved-medgemma' }),
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
      mockHarnessPolicyService as any, // HarnessPolicyService resolver
      undefined, // configResolver (@Optional)
      undefined, // entitlements (@Optional)
      undefined, // trajectoryService (@Optional)
      undefined, // aiTaskDefaultService (@Optional)
      undefined, // transcriptSegmentRepository (@Optional)
      undefined, // usageLedger (@Optional)
      undefined, // unitOfWork (@Optional)
      undefined, // billing (@Optional)
      undefined, // departmentAgentRepository (@Optional)
      undefined, // aiModelRepository (@Optional)
      undefined, // noteGenerationService (@Optional)
      // TASK-710 (re-opened): `IPhiRedactor` is REQUIRED — `extractEntities`
      // aborts rather than posting raw PHI to the NLP service. A pass-through
      // double keeps every pre-existing assertion in this file (which asserts
      // on the NLP request body / persisted entities) byte-identical, while
      // still exercising the mandatory call. The dedicated redaction spec
      // (`summary.service.phi-redaction.task710.test.ts`) owns the assertions
      // about what is actually posted.
      { redact: vi.fn(async (text: string) => text) } as any, // phiRedactor
    );
  });

  // ── callTextService passes the cascade-resolved model ──
  describe('callTextService TEXT selection', () => {
    const primeGenerateMocks = () => {
      mockConsultationRepository.findById.mockResolvedValue(consultationFixture({ id: 'c-1', tenantId: 'tenant-1' }));
      mockContextItemRepository.findTranscripts.mockResolvedValue([{ content: 'transcript text' }]);
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });
      mockContextItemRepository.create.mockResolvedValue({ id: 'ctx-new', content: 'S', createdAt: new Date(), updatedAt: new Date() });
      mockSummaryMetaRepository.create.mockResolvedValue({ id: 'meta-1' });
    };

    const lastTextBody = () => {
      const call = mockHttpService.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/api/v1/generate'))!;
      return call[1] as { provider?: string; model?: string };
    };

    it('posts the cascade-resolved provider+model when the request omits a model', async () => {
      primeGenerateMocks();

      await service.generateSummary('c-1', { dnaStyleId: 'style-1' } as any);

      expect(mockHarnessPolicyService.resolveTextSelection).toHaveBeenCalled();
      const body = lastTextBody();
      expect(body.provider).toBe('lm-studio');
      expect(body.model).toBe('resolved-medgemma');
    });

    // GenerateSummary is a one-shot/finalize path: it must
    // keep resolving the DEFAULT ('finalize') tier, never the live tier, so a
    // super admin's `text.live` re-point never leaks into final summaries.
    // The tenant id is now resolved EXPLICITLY (never a
    // bare no-arg call trusting the callee's own CLS fallback), so a worker
    // path with unpopulated CLS fails loudly instead of silently serving the
    // SYSTEM default model.
    it('resolves the default (finalize) tier with the CLS tenant passed explicitly', async () => {
      primeGenerateMocks();

      await service.generateSummary('c-1', { dnaStyleId: 'style-1' } as any);

      expect(mockHarnessPolicyService.resolveTextSelection).toHaveBeenCalledWith('tenant-1', 'finalize');
    });

    it('lets a caller-supplied model win over the resolved default', async () => {
      primeGenerateMocks();

      await service.generateSummary('c-1', { options: { model: 'caller-pinned' } } as any);

      const body = lastTextBody();
      expect(body.model).toBe('caller-pinned');
    });
  });

  // ── persist the AD-1 GenerationStats headline fields ──
  // The TEXT /generate response now carries a `stats` block (stop_reason,
  // ttft_ms, tokens_per_second, …). generateSummary/generatePreSummary must
  // persist the three headline fields onto SummaryMeta via the factory/entity
  // path. `stats` may be null (legacy idempotency-cache hit) → degrade cleanly.
  describe('generation stats persistence', () => {
    const primeGenerateMocks = (data: Record<string, unknown>) => {
      mockConsultationRepository.findById.mockResolvedValue(consultationFixture({ id: 'c-1', tenantId: 'tenant-1' }));
      mockContextItemRepository.findTranscripts.mockResolvedValue([{ content: 'transcript text' }]);
      mockContextItemRepository.findLatestPreSummary.mockResolvedValue(null);
      mockHttpService.axiosRef.post.mockResolvedValue({ data });
      mockContextItemRepository.create.mockResolvedValue({ id: 'ctx-new', content: 'S', createdAt: new Date(), updatedAt: new Date() });
      mockSummaryMetaRepository.create.mockResolvedValue({ id: 'meta-1' });
    };

    const persistedMeta = () =>
      mockSummaryMetaRepository.create.mock.calls[0][0] as {
        stopReason?: string | null;
        ttftMs?: number | null;
        tokensPerSecond?: number | null;
      };

    const POPULATED_STATS = {
      stop_reason: 'length',
      stop_reason_raw: 'stopped_limit',
      total_ms: 1234,
      ttft_ms: 210,
      tokens_per_second: 42.5,
      prompt_tokens: 100,
      predicted_tokens: 50,
      total_tokens: 150,
      provider: 'vllm',
      model: 'm',
      engine_native: null,
    };

    it('persists stopReason/ttftMs/tokensPerSecond from a populated TEXT stats block (generateSummary)', async () => {
      primeGenerateMocks({ summary: 'S', modelName: 'm', stats: POPULATED_STATS });

      await service.generateSummary('c-1', { dnaStyleId: 'style-1' } as any);

      expect(mockSummaryMetaRepository.create).toHaveBeenCalledTimes(1);
      const meta = persistedMeta();
      expect(meta.stopReason).toBe('length');
      expect(meta.ttftMs).toBe(210);
      expect(meta.tokensPerSecond).toBe(42.5);
    });

    it('persists stopReason/ttftMs/tokensPerSecond from a populated TEXT stats block (generatePreSummary)', async () => {
      mockConsultationRepository.findById.mockResolvedValue(consultationFixture({ id: 'c-1', tenantId: 'tenant-1' }));
      mockContextItemRepository.findCaseNotes.mockResolvedValue([{ id: 'cn-1', content: 'case note content' }]);
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm', stats: POPULATED_STATS } });
      mockContextItemRepository.create.mockResolvedValue({ id: 'ctx-pre', content: 'S', createdAt: new Date(), updatedAt: new Date() });
      mockSummaryMetaRepository.create.mockResolvedValue({ id: 'meta-1' });

      await service.generatePreSummary('c-1', {} as any);

      const meta = persistedMeta();
      expect(meta.stopReason).toBe('length');
      expect(meta.ttftMs).toBe(210);
      expect(meta.tokensPerSecond).toBe(42.5);
    });

    it('degrades cleanly when TEXT stats is null — no crash, stats fields unset', async () => {
      primeGenerateMocks({ summary: 'S', modelName: 'm', stats: null });

      await expect(service.generateSummary('c-1', { dnaStyleId: 'style-1' } as any)).resolves.toBeDefined();

      const meta = persistedMeta();
      expect(meta.stopReason ?? null).toBeNull();
      expect(meta.ttftMs ?? null).toBeNull();
      expect(meta.tokensPerSecond ?? null).toBeNull();
    });

    it('degrades cleanly when TEXT omits the stats block entirely', async () => {
      primeGenerateMocks({ summary: 'S', modelName: 'm' });

      await expect(service.generateSummary('c-1', { dnaStyleId: 'style-1' } as any)).resolves.toBeDefined();

      const meta = persistedMeta();
      expect(meta.stopReason ?? null).toBeNull();
      expect(meta.ttftMs ?? null).toBeNull();
      expect(meta.tokensPerSecond ?? null).toBeNull();
    });
  });

  // ===========================================================================
  // extractEntities — Core Persistence Behavior
  // ===========================================================================

  describe('extractEntities', () => {
    // ----- Successful persistence -----

    it('should persist entities returned by NLP service to NamedEntityRepository', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Patient with Diabetes' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          entities: [{ type: 'CONDITION', value: 'Diabetes', confidence: 0.95, start: 13, end: 21 }],
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

    // (AC-3b) — the sync durable path persists the ontology codes
    // the NLP producer now emits (same shared mapper as the async path). RED
    // before the mapper maps them (they were dropped → columns null).
    it('passes the NLP ontology codes into the NamedEntity factory', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Patient takes metformin' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          entities: [
            {
              text: 'metformin',
              entity_type: 'MEDICATION',
              confidence: 0.97,
              position: { start: 14, end: 23 },
              umls_cui: 'C0025598',
              rxnorm_code: '6809',
            },
          ],
        },
      });
      mockNamedEntityRepository.create.mockResolvedValue({ id: 'entity-476' });

      await service.extractEntities('ctx-item-123');

      expect(NamedEntityFactory.CreateNamedEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'metformin',
          className: 'MEDICATION',
          umlsCui: 'C0025598',
          rxnormCode: '6809',
        }),
      );
    });

    it('should persist multiple entities from NLP response', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Patient John Doe with Diabetes takes Metformin' }));
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
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { entities: [] },
      });

      await service.extractEntities('ctx-item-123');

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining('/classify/tokens'),
        { text: content },
        expect.objectContaining({ headers: expect.objectContaining({ 'X-Tenant-Id': expect.any(String) }) }),
      );
    });

    // ----- NLP response field mapping -----

    it('should map NLP response with value/type fields (primary naming)', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Test content' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          entities: [{ type: 'MEDICATION', value: 'Aspirin', confidence: 0.97, start: 10, end: 17 }],
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
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Test content' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          entities: [{ className: 'PROCEDURE', text: 'MRI', confidence: 0.88, startOffset: 5, endOffset: 8 }],
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

    // The REAL NLP contract ({ text, entity_type, confidence,
    // position: { start, end } }; canonical apps/nlp/src/nlp/schemas/common.py).
    // Current code reads className via `type ?? className` and offsets via
    // `start ?? startOffset`, so both resolve undefined for the real shape and
    // persist blank/null — durable corruption. text survives via `?? entity.text`.
    it('should map the REAL NLP contract (entity_type + position) to className/offsets', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Take aspirin now' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          entities: [{ text: 'aspirin', entity_type: 'MEDICATION', confidence: 0.9, position: { start: 8, end: 15 } }],
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
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Text with no entities' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { entities: [] },
      });

      await service.extractEntities('ctx-item-123');

      expect(mockNamedEntityRepository.create).not.toHaveBeenCalled();
    });

    it('should not call repository.create when NLP returns undefined entities', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Some text' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { entities: undefined },
      });

      await service.extractEntities('ctx-item-123');

      expect(mockNamedEntityRepository.create).not.toHaveBeenCalled();
    });

    // ----- Partial failure resilience -----

    it('should continue persisting remaining entities when one fails', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Test content' }));
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
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ id: 'ctx-99', content: 'Test' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          entities: [
            { type: 'CONDITION', value: 'Flu', confidence: 0.9 },
            { type: 'MEDICATION', value: 'Tamiflu', confidence: 0.85 },
          ],
        },
      });
      mockNamedEntityRepository.create.mockResolvedValueOnce({ id: 'entity-1' }).mockRejectedValueOnce(new Error('DB error'));

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
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ id: 'ctx-full', content: 'Content' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          entities: [{ type: 'PERSON', value: 'Jane', confidence: 0.95 }],
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
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Valid content' }));

      await expect(service.extractEntities('ctx-item-123')).rejects.toThrow(BadRequestException);
    });

    // ----- Existing validation -----

    it('should throw NotFoundException when context item not found', async () => {
      mockContextItemRepository.findById.mockResolvedValue(null);

      await expect(service.extractEntities('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when context item has no content', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: '' }));

      await expect(service.extractEntities('ctx-empty')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when context item content is only whitespace', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: '   \n\t  ' }));

      await expect(service.extractEntities('ctx-ws')).rejects.toThrow(BadRequestException);
    });

    // TASK-768: this used to assert a `BadRequestException` whose message was
    // `Failed to call NLP service: ${error}` — a 400 blaming the caller for an
    // absent dependency, carrying the NLP host:port. The service now RETHROWS
    // the cause unchanged; the gateway boundary
    // (`apps/api/src/filters/downstream-error.ts`, applied by
    // `ExceptionInterceptor`) classifies it into 503/502/4xx and is the only
    // thing that builds a client-facing body.
    it('rethrows the underlying cause when the NLP service call fails, without wrapping it in a 400', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Valid content' }));
      const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8864'), { code: 'ECONNREFUSED' });
      mockHttpService.axiosRef.post.mockRejectedValue(cause);

      await expect(service.extractEntities('ctx-item-123')).rejects.toBe(cause);
      await expect(service.extractEntities('ctx-item-123')).rejects.not.toBeInstanceOf(BadRequestException);
    });

    // ----- Entities without optional fields -----

    it('should persist entities without confidence or position data', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Test content' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          entities: [{ type: 'SYMPTOM', value: 'headache' }],
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
      const medicalContent =
        'Patient John Smith, 67yo male, presents with chest pain. ' +
        'History: hypertension, Type 2 Diabetes. Meds: Metoprolol 50mg, Metformin 1000mg.';

      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: medicalContent }));
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
  // Nlp.ner AiTaskDefault model injection (fail-open)
  // ===========================================================================

  describe('extractEntities — nlp.ner model injection', () => {
    it('injects the effective nlp.ner model_name when the AiTaskDefault service resolves one', async () => {
      const aiTaskDefaultService = {
        getEffective: vi.fn().mockResolvedValue({
          model: { sourceUri: 'blaze999/Medical-NER' },
        }),
      };
      const serviceWithResolver = new SummaryService(
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
        undefined, // harnessGatewayService
        mockHarnessPolicyService as any,
        undefined, // configResolver
        undefined, // entitlements
        undefined, // trajectoryService
        aiTaskDefaultService as any,
        undefined, // transcriptSegmentRepository
        undefined, // usageLedger
        undefined, // unitOfWork
        undefined, // billing
        undefined, // departmentAgentRepository
        undefined, // aiModelRepository
        undefined, // noteGenerationService
        // TASK-710 — `IPhiRedactor` is a REQUIRED ctor dep; a pass-through
        // double keeps this fixture's assertions byte-identical.
        { redact: vi.fn(async (text: string) => text) } as any, // phiRedactor (#27)
      );

      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Patient with Diabetes' }));
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { entities: [] } });

      await serviceWithResolver.extractEntities('ctx-item-123');

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        'http://localhost:8864/api/v1/classify/tokens',
        {
          text: 'Patient with Diabetes',
          model_name: 'blaze999/Medical-NER',
        },
        expect.objectContaining({ headers: expect.objectContaining({ 'X-Tenant-Id': expect.any(String) }) }),
      );
    });

    it('posts without model_name (fail-open) when AiTaskDefault resolution fails', async () => {
      const aiTaskDefaultService = {
        getEffective: vi.fn().mockRejectedValue(new Error('registry unavailable')),
      };
      const serviceWithResolver = new SummaryService(
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
        undefined,
        undefined,
        undefined,
        undefined,
        mockHarnessPolicyService as any,
        undefined,
        undefined,
        undefined,
        aiTaskDefaultService as any,
        undefined, // transcriptSegmentRepository
        undefined, // usageLedger
        undefined, // unitOfWork
        undefined, // billing
        undefined, // departmentAgentRepository
        undefined, // aiModelRepository
        undefined, // noteGenerationService
        // TASK-710 — `IPhiRedactor` is a REQUIRED ctor dep; a pass-through
        // double keeps this fixture's assertions byte-identical.
        { redact: vi.fn(async (text: string) => text) } as any, // phiRedactor (#27)
      );

      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Patient with Diabetes' }));
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { entities: [] } });

      await serviceWithResolver.extractEntities('ctx-item-123');

      // extraction proceeds — a registry hiccup never blocks clinical NER.
      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        'http://localhost:8864/api/v1/classify/tokens',
        { text: 'Patient with Diabetes' },
        expect.objectContaining({ headers: expect.objectContaining({ 'X-Tenant-Id': expect.any(String) }) }),
      );
    });

    it('posts without model_name when no AiTaskDefault service is wired (legacy behavior preserved)', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Patient with Diabetes' }));
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { entities: [] } });

      await service.extractEntities('ctx-item-123');

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        'http://localhost:8864/api/v1/classify/tokens',
        { text: 'Patient with Diabetes' },
        expect.objectContaining({ headers: expect.objectContaining({ 'X-Tenant-Id': expect.any(String) }) }),
      );
    });
  });

  // ===========================================================================
  // NLP URL Path + Service URL Standardization
  // ===========================================================================

  describe('Service URL Configuration', () => {
    // ----- ConfigService integration (replaces process.env) -----

    it('should read TEXT_URL from ConfigService', () => {
      expect(mockConfigService.get).toHaveBeenCalledWith('TEXT_URL');
    });

    it('should read NLP_URL from ConfigService', () => {
      expect(mockConfigService.get).toHaveBeenCalledWith('NLP_URL');
    });

    it('should use ConfigService-provided TEXT URL when calling TEXT service', async () => {
      const customTextUrl = 'http://text-production:8862';
      const configWithCustomUrls = createMockConfigService();
      configWithCustomUrls.get.mockImplementation((key: string) => {
        if (key === 'TEXT_URL') return customTextUrl;
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
        undefined, // secretsService
        undefined, // userProfileRepository
        undefined, // harnessAuditService
        undefined, // harnessGatewayService
        undefined, // harnessPolicyService
        undefined, // configResolver
        undefined, // entitlements
        undefined, // trajectoryService
        undefined, // aiTaskDefaultService
        undefined, // transcriptSegmentRepository
        undefined, // usageLedger
        undefined, // unitOfWork
        undefined, // billing
        undefined, // departmentAgentRepository
        undefined, // aiModelRepository
        undefined, // noteGenerationService
        // TASK-710 — `IPhiRedactor` is a REQUIRED ctor dep; a pass-through
        // double keeps this fixture's assertions byte-identical.
        { redact: vi.fn(async (text: string) => text) } as any, // phiRedactor (#27)
      );

      mockConsultationRepository.findById.mockResolvedValue(consultationFixture({ id: 'c-1', tenantId: 'tenant-1' }));
      mockContextItemRepository.findTranscripts.mockResolvedValue([{ content: 'transcript text' }]);
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
        `${customTextUrl}/api/v1/generate`,
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
        if (key === 'TEXT_URL') return 'http://text:8862';
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
        undefined, // secretsService
        undefined, // userProfileRepository
        undefined, // harnessAuditService
        undefined, // harnessGatewayService
        undefined, // harnessPolicyService
        undefined, // configResolver
        undefined, // entitlements
        undefined, // trajectoryService
        undefined, // aiTaskDefaultService
        undefined, // transcriptSegmentRepository
        undefined, // usageLedger
        undefined, // unitOfWork
        undefined, // billing
        undefined, // departmentAgentRepository
        undefined, // aiModelRepository
        undefined, // noteGenerationService
        // TASK-710 — `IPhiRedactor` is a REQUIRED ctor dep; a pass-through
        // double keeps this fixture's assertions byte-identical.
        { redact: vi.fn(async (text: string) => text) } as any, // phiRedactor (#27)
      );

      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Patient data' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { entities: [] },
      });

      await serviceWithCustomUrl.extractEntities('ctx-item-123');

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        `${customNlpUrl}/api/v1/classify/tokens`,
        { text: 'Patient data' },
        expect.objectContaining({ headers: expect.objectContaining({ 'X-Tenant-Id': expect.any(String) }) }),
      );
    });

    it('should call NLP service at /api/v1/classify/tokens (not /classify/tokens)', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Test content' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { entities: [] },
      });

      await service.extractEntities('ctx-item-123');

      const calledUrl = mockHttpService.axiosRef.post.mock.calls[0][0] as string;

      expect(calledUrl).toContain('/api/v1/classify/tokens');
      expect(calledUrl).not.toBe('http://localhost:8864/classify/tokens');
    });

    it('should use NLP URL path consistent with NerProcessor (/api/v1/classify/tokens)', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Medical text for NER' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { entities: [{ type: 'CONDITION', value: 'Flu', confidence: 0.9 }] },
      });
      mockNamedEntityRepository.create.mockResolvedValue({ id: 'e-1' });

      await service.extractEntities('ctx-item-123');

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        'http://localhost:8864/api/v1/classify/tokens',
        expect.any(Object),
        expect.objectContaining({ headers: expect.objectContaining({ 'X-Tenant-Id': expect.any(String) }) }),
      );
    });

    it('should default TEXT URL to http://localhost:8862 when ConfigService returns undefined', () => {
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
        undefined, // secretsService
        undefined, // userProfileRepository
        undefined, // harnessAuditService
        undefined, // harnessGatewayService
        undefined, // harnessPolicyService
        undefined, // configResolver
        undefined, // entitlements
        undefined, // trajectoryService
        undefined, // aiTaskDefaultService
        undefined, // transcriptSegmentRepository
        undefined, // usageLedger
        undefined, // unitOfWork
        undefined, // billing
        undefined, // departmentAgentRepository
        undefined, // aiModelRepository
        undefined, // noteGenerationService
        // TASK-710 — `IPhiRedactor` is a REQUIRED ctor dep; a pass-through
        // double keeps this fixture's assertions byte-identical.
        { redact: vi.fn(async (text: string) => text) } as any, // phiRedactor (#27)
      );

      mockConsultationRepository.findById.mockResolvedValue(consultationFixture({ id: 'c-1', tenantId: 'tenant-1' }));
      mockContextItemRepository.findTranscripts.mockResolvedValue([{ content: 'transcript' }]);
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

      return serviceWithDefaults.generateSummary('c-1', { dnaStyleId: 's' } as any).then(() => {
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
        undefined, // secretsService
        undefined, // userProfileRepository
        undefined, // harnessAuditService
        undefined, // harnessGatewayService
        undefined, // harnessPolicyService
        undefined, // configResolver
        undefined, // entitlements
        undefined, // trajectoryService
        undefined, // aiTaskDefaultService
        undefined, // transcriptSegmentRepository
        undefined, // usageLedger
        undefined, // unitOfWork
        undefined, // billing
        undefined, // departmentAgentRepository
        undefined, // aiModelRepository
        undefined, // noteGenerationService
        // TASK-710 — `IPhiRedactor` is a REQUIRED ctor dep; a pass-through
        // double keeps this fixture's assertions byte-identical.
        { redact: vi.fn(async (text: string) => text) } as any, // phiRedactor (#27)
      );

      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Test' }));
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { entities: [] },
      });

      await serviceWithDefaults.extractEntities('ctx-item-123');

      const calledUrl = mockHttpService.axiosRef.post.mock.calls[0][0] as string;
      expect(calledUrl).toBe('http://localhost:8864/api/v1/classify/tokens');
      expect(calledUrl).not.toContain(':8004');
    });

    it('should call TEXT service at /api/v1/generate', async () => {
      mockConsultationRepository.findById.mockResolvedValue(consultationFixture({ id: 'c-1', tenantId: 'tenant-1' }));
      mockContextItemRepository.findCaseNotes.mockResolvedValue([{ content: 'Historical case note content' }]);
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
        undefined, // secretsService
        undefined, // userProfileRepository
        undefined, // harnessAuditService
        undefined, // harnessGatewayService
        undefined, // harnessPolicyService
        undefined, // configResolver
        undefined, // entitlements
        undefined, // trajectoryService
        undefined, // aiTaskDefaultService
        undefined, // transcriptSegmentRepository
        undefined, // usageLedger
        undefined, // unitOfWork
        undefined, // billing
        undefined, // departmentAgentRepository
        undefined, // aiModelRepository
        undefined, // noteGenerationService
        // TASK-710 — `IPhiRedactor` is a REQUIRED ctor dep; a pass-through
        // double keeps this fixture's assertions byte-identical.
        { redact: vi.fn(async (text: string) => text) } as any, // phiRedactor (#27)
      );

      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Test' }));
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { entities: [] } });

      return serviceWithDefaults.extractEntities('ctx-item-123').then(() => {
        const calledUrl = mockHttpService.axiosRef.post.mock.calls[0][0] as string;
        expect(calledUrl).toMatch(/^http:\/\/localhost:8864\//);
      });
    });

    it('should use same default TEXT port (8862) as SummaryProcessor', () => {
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
        undefined, // secretsService
        undefined, // userProfileRepository
        undefined, // harnessAuditService
        undefined, // harnessGatewayService
        undefined, // harnessPolicyService
        undefined, // configResolver
        undefined, // entitlements
        undefined, // trajectoryService
        undefined, // aiTaskDefaultService
        undefined, // transcriptSegmentRepository
        undefined, // usageLedger
        undefined, // unitOfWork
        undefined, // billing
        undefined, // departmentAgentRepository
        undefined, // aiModelRepository
        undefined, // noteGenerationService
        // TASK-710 — `IPhiRedactor` is a REQUIRED ctor dep; a pass-through
        // double keeps this fixture's assertions byte-identical.
        { redact: vi.fn(async (text: string) => text) } as any, // phiRedactor (#27)
      );

      mockConsultationRepository.findById.mockResolvedValue(consultationFixture({ id: 'c-1', tenantId: 'tenant-1' }));
      mockContextItemRepository.findTranscripts.mockResolvedValue([{ content: 'transcript' }]);
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

      return serviceWithDefaults.generateSummary('c-1', { dnaStyleId: 's' } as any).then(() => {
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
      expect(mockedFactory.CreateFromContextItem).toHaveBeenCalledWith(mockItem, 1, 'Manual edit', 'user-1', 'doctor_edit', undefined);
    });

    // Editing must bump currentVersionNumber on the persisted item (no in-place overwrite)
    it('should persist the bumped currentVersionNumber on the edited summary', async () => {
      const mockItem = createMockContextItem({
        id: 'ctx-bump-329',
        content: 'Original',
        currentVersionNumber: 2,
      });
      mockContextItemRepository.findById.mockResolvedValue(mockItem);
      mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-3' });
      mockContextItemRepository.update.mockImplementation((_id: string, item: { currentVersionNumber?: number }) =>
        Promise.resolve({
          ...item,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );

      await service.updateSummary('ctx-bump-329', { content: 'Edited content' });

      expect(mockedFactory.CreateFromContextItem).toHaveBeenCalledWith(mockItem, 3, 'Manual edit', 'user-1', 'doctor_edit', undefined);
      expect(mockContextItemRepository.update).toHaveBeenCalledWith('ctx-bump-329', expect.objectContaining({ currentVersionNumber: 3 }));
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

      await expect(service.updateSummary('non-existent', { content: 'test' })).rejects.toThrow(NotFoundException);

      expect(mockContextItemVersionRepository.create).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException for non-summary items', async () => {
      const mockItem = createMockContextItem({
        id: 'ctx-transcript',
        isSummary: false,
      });
      mockContextItemRepository.findById.mockResolvedValue(mockItem);

      await expect(service.updateSummary('ctx-transcript', { content: 'test' })).rejects.toThrow(BadRequestException);

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
        undefined, // secretsService
        undefined, // userProfileRepository
        undefined, // harnessAuditService
        undefined, // harnessGatewayService
        undefined, // harnessPolicyService
        undefined, // configResolver
        undefined, // entitlements
        undefined, // trajectoryService
        undefined, // aiTaskDefaultService
        undefined, // transcriptSegmentRepository
        undefined, // usageLedger
        undefined, // unitOfWork
        undefined, // billing
        undefined, // departmentAgentRepository
        undefined, // aiModelRepository
        undefined, // noteGenerationService
        // TASK-710 — `IPhiRedactor` is a REQUIRED ctor dep; a pass-through
        // double keeps this fixture's assertions byte-identical.
        { redact: vi.fn(async (text: string) => text) } as any, // phiRedactor (#27)
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
        undefined, // secretsService
        undefined, // userProfileRepository
        undefined, // harnessAuditService
        undefined, // harnessGatewayService
        undefined, // harnessPolicyService
        undefined, // configResolver
        undefined, // entitlements
        undefined, // trajectoryService
        undefined, // aiTaskDefaultService
        undefined, // transcriptSegmentRepository
        undefined, // usageLedger
        undefined, // unitOfWork
        undefined, // billing
        undefined, // departmentAgentRepository
        undefined, // aiModelRepository
        undefined, // noteGenerationService
        // TASK-710 — `IPhiRedactor` is a REQUIRED ctor dep; a pass-through
        // double keeps this fixture's assertions byte-identical.
        { redact: vi.fn(async (text: string) => text) } as any, // phiRedactor (#27)
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
      mockContextItemVersionRepository.create.mockRejectedValue(new Error('Database constraint violation'));

      await expect(service.updateSummary('ctx-ver-fail', { content: 'New' })).rejects.toThrow('Database constraint violation');

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

      expect(result).toEqual(
        expect.objectContaining({
          id: 'ctx-resp',
          consultationId: 'consultation-1',
          type: 'RAW_SUMMARY',
          content: 'Updated content',
        }),
      );
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

    // TASK-709: OCC — updateSummary routes through the Compare-And-Set
    // repository call, threading the caller-supplied `expectedVersion`
    // through, and never falls back to the legacy non-versioned write.
    describe('optimistic concurrency (TASK-709)', () => {
      it('routes through updateWithVersion using request.expectedVersion, not the legacy update()', async () => {
        const mockItem = createMockContextItem({ id: 'ctx-occ-1', content: 'Original' });
        mockContextItemRepository.findById.mockResolvedValue(mockItem);
        mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-occ-1' });
        mockContextItemRepository.updateWithVersion.mockResolvedValue({
          ...mockItem,
          content: 'Updated',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        await service.updateSummary('ctx-occ-1', { content: 'Updated', expectedVersion: 3 });

        // The 4th argument is the transaction client: the version-row insert and
        // this CAS now share one transaction, so a rejected (412) write no longer
        // leaves an orphan `ContextItemVersion` behind to collide with the next
        // edit's version number. `undefined` here because these fixtures build the
        // service without a unit of work.
        expect(mockContextItemRepository.updateWithVersion).toHaveBeenCalledWith('ctx-occ-1', mockItem, 3, undefined);
        // CAS-only — the legacy non-versioned write MUST NOT fire.
        expect(mockContextItemRepository.update).not.toHaveBeenCalled();
      });

      it('propagates OptimisticConcurrencyException on version drift (412)', async () => {
        const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
        const mockItem = createMockContextItem({ id: 'ctx-occ-2', content: 'Original' });
        mockContextItemRepository.findById.mockResolvedValue(mockItem);
        mockContextItemVersionRepository.create.mockResolvedValue({ id: 'v-occ-2' });
        const occErr = new OptimisticConcurrencyException('ContextItem', 'ctx-occ-2', {
          expectedVersion: 3,
          currentVersion: 5,
        });
        mockContextItemRepository.updateWithVersion.mockRejectedValue(occErr);

        await expect(service.updateSummary('ctx-occ-2', { content: 'Updated', expectedVersion: 3 })).rejects.toBe(occErr);
      });
    });
  });

  // ============================================================
  // Cross-aggregate tenant isolation for SummaryService
  //
  // The summary pipeline takes either `consultationId` (generate*) or
  // `contextItemId` (update/approve/extract) — both reference aggregates
  // that may be tenant-scoped to a foreign tenant.
  //
  // All cross-aggregate checks throw `NotFoundException` (no existence
  // leak); legitimate misses produce the same error shape as cross-tenant
  // probes.
  // ============================================================
  describe('cross-aggregate tenant checks', () => {
    describe('generatePreSummary', () => {
      it('throws NotFoundException when parent consultation belongs to another tenant', async () => {
        mockConsultationRepository.findById.mockResolvedValue(
          consultationFixture({
            id: 'c-other',
            tenantId: 'tenant-OTHER',
          }),
        );

        await expect(service.generatePreSummary('c-other', {} as any)).rejects.toThrow(NotFoundException);
        expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
        expect(mockContextItemRepository.create).not.toHaveBeenCalled();
      });
    });

    describe('generateSummary', () => {
      it('throws NotFoundException when parent consultation belongs to another tenant', async () => {
        mockConsultationRepository.findById.mockResolvedValue(
          consultationFixture({
            id: 'c-other',
            tenantId: 'tenant-OTHER',
          }),
        );

        await expect(service.generateSummary('c-other', { transcription: 'x' } as any)).rejects.toThrow(NotFoundException);
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

        await expect(service.updateSummary('ctx-other', { content: 'tampered' } as any)).rejects.toThrow(NotFoundException);
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

        await expect(service.approveSummary('ctx-other')).rejects.toThrow(NotFoundException);
        expect(mockContextItemRepository.update).not.toHaveBeenCalled();
      });
    });

    // ===================================================================
    // Attestation gate (confirm-before-commit)
    //
    // approveSummary MUST, in one path that cannot be bypassed:
    //   1. write a SIGNED_NOTE ContextItemVersion carrying attestation fields,
    //   2. append an ATTEST HarnessAuditEvent (Phase-0 WORM trail),
    //   3. flip Consultation.status → SIGNED.
    // ===================================================================
    describe('approveSummary — attestation gate (Phase 1)', () => {
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
        mockConsultationRepository.findById.mockResolvedValue(
          consultationFixture({
            id: 'consultation-1',
            tenantId: 'tenant-1',
            status: ConsultationStatus.PENDING_REVIEW, // TASK-711: OPEN cannot legally reach SIGNED; PENDING_REVIEW can
            updatedBy: null,
          }),
        );
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
    // RELAXED sign-off governance
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
    describe('approveSummary — Phase D assurance guard', () => {
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
        mockConsultationRepository.findById.mockResolvedValue(
          consultationFixture({
            id: 'consultation-1',
            tenantId: 'tenant-1',
            status: ConsultationStatus.PENDING_REVIEW,
            updatedBy: null,
          }),
        );
        mockConsultationRepository.update.mockResolvedValue({ id: 'consultation-1' });
      });

      it('ALLOWS sign-off while assurance is pending (no ack) and records a SIGNED_BEFORE_ASSURANCE annotation', async () => {
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

      it('HARD-REJECTS sign-off past a safety FLAG WITHOUT the override flag (object shape)', async () => {
        mockSummaryMetaRepository.findByContextItem.mockResolvedValue({
          id: 'sm-1',
          assuranceCompletedAt: new Date(),
          guardrailDecisions: { safety: { decision: 'FLAG' } },
        });

        await expect(gatedService.approveSummary('ctx-item-123')).rejects.toThrow(ConflictException);
        expect(ContextItemVersionFactory.CreateSignedNoteVersion).not.toHaveBeenCalled();
        expect(mockHarnessAuditService.append).not.toHaveBeenCalled();
      });

      it('HARD-REJECTS sign-off past a safety FLAG WITHOUT the override flag (string shape)', async () => {
        mockSummaryMetaRepository.findByContextItem.mockResolvedValue({
          id: 'sm-1',
          assuranceCompletedAt: new Date(),
          guardrailDecisions: { safety: 'FLAG' },
        });

        await expect(gatedService.approveSummary('ctx-item-123')).rejects.toThrow(ConflictException);
      });

      it('ALLOWS sign-off past a completed safety FLAG via one-click override + records a SAFETY_OVERRIDE WORM event', async () => {
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

      it('the SAFETY_OVERRIDE WORM append is FAIL-CLOSED (override audit failure rejects the sign)', async () => {
        mockSummaryMetaRepository.findByContextItem.mockResolvedValue({
          id: 'sm-1',
          assuranceCompletedAt: new Date(),
          guardrailDecisions: { safety: { decision: 'FLAG' } },
        });
        // Fail the very first audit append (the SAFETY_OVERRIDE event).
        mockHarnessAuditService.append.mockRejectedValueOnce(new Error('audit chain unavailable'));

        await expect(gatedService.approveSummary('ctx-item-123', { overrideSafetyFlag: true })).rejects.toThrow();
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
    // TASK-709 OCC — approveSummary CASes BOTH the Consultation row (its own
    // freshly-read `.version`) and the ContextItem row (the caller-supplied
    // `expectedVersion`), never the legacy non-versioned `.update()`.
    // ===================================================================
    describe('approveSummary — optimistic concurrency (TASK-709)', () => {
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
        mockConsultationRepository.findById.mockResolvedValue(
          consultationFixture({
            id: 'consultation-1',
            tenantId: 'tenant-1',
            status: ConsultationStatus.PENDING_REVIEW,
            updatedBy: null,
            version: 6,
          }),
        );
      });

      it('CASes the ContextItem row with the caller-supplied expectedVersion and the Consultation row with its own freshly-read version', async () => {
        mockContextItemRepository.updateWithVersion.mockResolvedValue({ id: 'ctx-item-123' });
        mockConsultationRepository.updateWithVersion.mockResolvedValue({ id: 'consultation-1' });

        await gatedService.approveSummary('ctx-item-123', { expectedVersion: 4 });

        expect(mockContextItemRepository.updateWithVersion).toHaveBeenCalledWith('ctx-item-123', expect.objectContaining({ id: 'ctx-item-123' }), 4);
        expect(mockConsultationRepository.updateWithVersion).toHaveBeenCalledWith(
          'consultation-1',
          expect.objectContaining({ status: ConsultationStatus.SIGNED }),
          6,
        );
        // CAS-only — the legacy non-versioned write MUST NOT fire on either row.
        expect(mockContextItemRepository.update).not.toHaveBeenCalled();
        expect(mockConsultationRepository.update).not.toHaveBeenCalled();
      });

      it('propagates OptimisticConcurrencyException when the ContextItem row has drifted (412)', async () => {
        const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
        const occErr = new OptimisticConcurrencyException('ContextItem', 'ctx-item-123', {
          expectedVersion: 4,
          currentVersion: 5,
        });
        mockConsultationRepository.updateWithVersion.mockResolvedValue({ id: 'consultation-1' });
        mockContextItemRepository.updateWithVersion.mockRejectedValue(occErr);

        await expect(gatedService.approveSummary('ctx-item-123', { expectedVersion: 4 })).rejects.toBe(occErr);
      });

      it('propagates OptimisticConcurrencyException when the Consultation row has drifted (412)', async () => {
        const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
        const occErr = new OptimisticConcurrencyException('Consultation', 'consultation-1', {
          expectedVersion: 6,
          currentVersion: 7,
        });
        mockConsultationRepository.updateWithVersion.mockRejectedValue(occErr);

        await expect(gatedService.approveSummary('ctx-item-123', { expectedVersion: 4 })).rejects.toBe(occErr);
      });
    });

    // ===================================================================
    // (Lane G) — best-effort harness sign-off signal
    //
    // AFTER the SIGNED_NOTE + ATTEST + status=SIGNED writes (the WORM trail
    // is the source of truth), approveSummary forwards the sign-off to the
    // harness so it can resolve the workflow's approval wait-condition. A
    // signal failure MUST NOT block or roll back the sign-off.
    // ===================================================================
    describe('approveSummary — harness sign-off signal (Lane G)', () => {
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
        mockConsultationRepository.findById.mockResolvedValue(
          consultationFixture({
            id: 'consultation-1',
            tenantId: 'tenant-1',
            status: ConsultationStatus.PENDING_REVIEW, // TASK-711: OPEN cannot legally reach SIGNED; PENDING_REVIEW can
            updatedBy: null,
          }),
        );
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
    // updateSummary edit-signal SENDER.
    //
    // A clinician edit of an optimistically-delivered draft that is STILL
    // under assurance (DRAFT_PENDING_SENSORS) is forwarded to the running
    // harness workflow's `edit` signal so assurance re-binds + re-runs on the
    // edited version (Q3) and silent regen-if-untouched is disabled (Q1).
    // Best-effort: the MODIFIED_SUMMARY version write is the source of truth;
    // a signal failure never rolls back the edit. Edits outside that window
    // (any other consultation status) do NOT signal.
    // ===================================================================
    describe('updateSummary — harness edit signal (Slice 5c)', () => {
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
        mockConsultationRepository.findById.mockResolvedValue(
          consultationFixture({
            id: 'consultation-1',
            tenantId: 'tenant-1',
            status: ConsultationStatus.DRAFT_PENDING_SENSORS,
          }),
        );

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
        mockConsultationRepository.findById.mockResolvedValue(
          consultationFixture({
            id: 'consultation-1',
            tenantId: 'tenant-1',
            status: ConsultationStatus.PENDING_REVIEW,
          }),
        );

        await editService.updateSummary('ctx-edit-1', { content: 'edited' });

        expect(mockHarnessGateway.signalEdit).not.toHaveBeenCalled();
      });

      it('does NOT signal when there is no consultation record', async () => {
        mockConsultationRepository.findById.mockResolvedValue(null);

        await editService.updateSummary('ctx-edit-1', { content: 'edited' });

        expect(mockHarnessGateway.signalEdit).not.toHaveBeenCalled();
      });

      it('still completes the edit when the harness edit signal throws (best-effort, not rolled back)', async () => {
        mockConsultationRepository.findById.mockResolvedValue(
          consultationFixture({
            id: 'consultation-1',
            tenantId: 'tenant-1',
            status: ConsultationStatus.DRAFT_PENDING_SENSORS,
          }),
        );
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

        await expect(service.extractEntities('ctx-other')).rejects.toThrow(NotFoundException);
        expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
        expect(mockNamedEntityRepository.create).not.toHaveBeenCalled();
      });
    });
  });

  // ── F-031 remainder: every ContextItem.content write lane in this
  // service must encrypt before persist, or clinical text silently vanishes at
  // rest (the plaintext `content` column was dropped; only `encryptedContent`
  // persists). Covers all 4 lanes: generatePreSummary (create), generateSummary
  // (create), updateSummary (MODIFIED_SUMMARY edit — update), approveSummary
  // (final update).
  describe('content encryption-at-rest (F-031)', () => {
    const secretsStub = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') };

    const buildServiceWithSecrets = (extra: unknown[] = []) =>
      new SummaryService(
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
        secretsStub as any,
        undefined, // userProfileRepository
        ...extra,
      );

    it('encrypts the generated pre-summary content before persisting (generatePreSummary)', async () => {
      const serviceWithSecrets = buildServiceWithSecrets();
      mockConsultationRepository.findById.mockResolvedValue(consultationFixture({ id: 'c-1', tenantId: 'tenant-1' }));
      mockContextItemRepository.findCaseNotes.mockResolvedValue([{ id: 'cn-1', content: 'case note content' }]);
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { summary: 'Pre-summary text', modelName: 'm' } });
      mockContextItemRepository.create.mockResolvedValue({
        id: 'ctx-pre-enc',
        content: 'Pre-summary text',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockSummaryMetaRepository.create.mockResolvedValue({ id: 'meta-1' });

      await serviceWithSecrets.generatePreSummary('c-1', {} as any);

      expect(mockContextItemRepository.encryptContentIntoEntity).toHaveBeenCalledTimes(1);
      const [entityArg, secretsArg] = mockContextItemRepository.encryptContentIntoEntity.mock.calls[0];
      expect(entityArg.content).toBe('Pre-summary text');
      expect(secretsArg).toBe(secretsStub);
      const encOrder = mockContextItemRepository.encryptContentIntoEntity.mock.invocationCallOrder[0];
      const createOrder = mockContextItemRepository.create.mock.invocationCallOrder[0];
      expect(encOrder).toBeLessThan(createOrder);
    });

    it('encrypts the generated summary content before persisting (generateSummary)', async () => {
      const serviceWithSecrets = buildServiceWithSecrets();
      mockConsultationRepository.findById.mockResolvedValue(consultationFixture({ id: 'c-1', tenantId: 'tenant-1' }));
      mockContextItemRepository.findTranscripts.mockResolvedValue([{ content: 'transcript text' }]);
      mockContextItemRepository.findLatestPreSummary.mockResolvedValue(null);
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { summary: 'Raw summary text', modelName: 'm' } });
      mockContextItemRepository.create.mockResolvedValue({
        id: 'ctx-raw-enc',
        content: 'Raw summary text',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockSummaryMetaRepository.create.mockResolvedValue({ id: 'meta-1' });

      await serviceWithSecrets.generateSummary('c-1', { dnaStyleId: 'style-1' } as any);

      expect(mockContextItemRepository.encryptContentIntoEntity).toHaveBeenCalledTimes(1);
      const [entityArg, secretsArg] = mockContextItemRepository.encryptContentIntoEntity.mock.calls[0];
      expect(entityArg.content).toBe('Raw summary text');
      expect(secretsArg).toBe(secretsStub);
      const encOrder = mockContextItemRepository.encryptContentIntoEntity.mock.invocationCallOrder[0];
      const createOrder = mockContextItemRepository.create.mock.invocationCallOrder[0];
      expect(encOrder).toBeLessThan(createOrder);
    });

    it('encrypts the edited content before persisting (updateSummary — clinician-edit MODIFIED_SUMMARY)', async () => {
      const serviceWithSecrets = buildServiceWithSecrets();
      const mockItem = createMockContextItem({
        id: 'ctx-edit-enc',
        content: 'Original summary content',
        currentVersionNumber: 0,
      });
      mockContextItemRepository.findById.mockResolvedValue(mockItem);
      mockContextItemVersionRepository.create.mockResolvedValue({ id: 'version-id-enc' });
      mockContextItemRepository.update.mockImplementation((_id: string, item: unknown) =>
        Promise.resolve({
          ...(item as object),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );

      await serviceWithSecrets.updateSummary('ctx-edit-enc', { content: 'Edited clinical content' });

      expect(mockContextItemRepository.encryptContentIntoEntity).toHaveBeenCalledTimes(1);
      const [entityArg, secretsArg] = mockContextItemRepository.encryptContentIntoEntity.mock.calls[0];
      expect(entityArg.content).toBe('Edited clinical content');
      expect(secretsArg).toBe(secretsStub);
      const encOrder = mockContextItemRepository.encryptContentIntoEntity.mock.invocationCallOrder[0];
      const updateOrder = mockContextItemRepository.update.mock.invocationCallOrder[0];
      expect(encOrder).toBeLessThan(updateOrder);
    });

    it('still persists (without ciphertext) when no SecretsService is wired (updateSummary)', async () => {
      const mockItem = createMockContextItem({ id: 'ctx-edit-no-sec', content: 'Original', currentVersionNumber: 0 });
      mockContextItemRepository.findById.mockResolvedValue(mockItem);
      mockContextItemVersionRepository.create.mockResolvedValue({ id: 'version-id-no-sec' });
      mockContextItemRepository.update.mockImplementation((_id: string, item: unknown) =>
        Promise.resolve({
          ...(item as object),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );

      await service.updateSummary('ctx-edit-no-sec', { content: 'No cipher wired' });

      expect(mockContextItemRepository.encryptContentIntoEntity).not.toHaveBeenCalled();
    });

    it('encrypts the final content before persisting (approveSummary)', async () => {
      const mockHarnessAuditService = createMockHarnessAuditService();
      const serviceWithSecrets = buildServiceWithSecrets([mockHarnessAuditService as any]);
      const finalSummary = {
        id: 'ctx-approve-enc',
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
      };
      mockContextItemRepository.findById.mockResolvedValue(finalSummary);
      mockContextItemVersionRepository.getVersionsByChangeReason.mockResolvedValue([]);
      mockContextItemVersionRepository.create.mockResolvedValue({ id: 'signed-version-enc' });
      mockConsultationRepository.findById.mockResolvedValue(
        consultationFixture({
          id: 'consultation-1',
          tenantId: 'tenant-1',
          status: ConsultationStatus.PENDING_REVIEW, // TASK-711: OPEN cannot legally reach SIGNED; PENDING_REVIEW can
          updatedBy: null,
        }),
      );
      mockConsultationRepository.update.mockResolvedValue({ id: 'consultation-1' });
      mockContextItemRepository.update.mockResolvedValue({ ...finalSummary });

      await serviceWithSecrets.approveSummary('ctx-approve-enc');

      expect(mockContextItemRepository.encryptContentIntoEntity).toHaveBeenCalledTimes(1);
      const [entityArg, secretsArg] = mockContextItemRepository.encryptContentIntoEntity.mock.calls[0];
      expect(entityArg.content).toBe('S: ... O: ... A: ... P: ...');
      expect(secretsArg).toBe(secretsStub);
      const encOrder = mockContextItemRepository.encryptContentIntoEntity.mock.invocationCallOrder[0];
      const updateOrder = mockContextItemRepository.update.mock.invocationCallOrder[0];
      expect(encOrder).toBeLessThan(updateOrder);
    });
  });

  // ===========================================================================
  // ExtractEntities (sync path) usage-ledger emission
  // ===========================================================================

  describe('extractEntities — usage-ledger emission', () => {
    const createMockUsageLedger = () => ({ recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o1'], events: 2 }) });

    const buildServiceWithLedger = (usageLedger: unknown, aiTaskDefaultService?: unknown) =>
      new SummaryService(
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
        undefined, // harnessGatewayService
        mockHarnessPolicyService as any,
        undefined, // configResolver
        undefined, // entitlements
        undefined, // trajectoryService
        aiTaskDefaultService as any,
        undefined, // transcriptSegmentRepository
        usageLedger as any,
        undefined, // unitOfWork
        undefined, // billing
        undefined, // departmentAgentRepository
        undefined, // aiModelRepository
        undefined, // noteGenerationService
        // TASK-710 — REQUIRED redactor; pass-through keeps these usage-ledger
        // assertions (charCount, model attribution) byte-identical.
        { redact: vi.fn(async (text: string) => text) } as any, // phiRedactor
      );

    it('emits TEXT_UNIT + REQUEST keyed to a freshly generated requestId, with consultationId as attribution', async () => {
      const usageLedger = createMockUsageLedger();
      const aiTaskDefaultService = { getEffective: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) };
      const svc = buildServiceWithLedger(usageLedger, aiTaskDefaultService);
      const content = 'y'.repeat(300); // 300 chars -> 3 TEXT_UNIT
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content, consultationId: 'consult-sync-1' }));
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { entities: [] } });

      await svc.extractEntities('ctx-item-123');

      expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
      const call = usageLedger.recordUsage.mock.calls[0][0];
      // The sync path has no natural durable job id, so idempotencyKey is
      // built from a freshly generated requestId — NEVER the consultationId
      // (that would silently drop every subsequent extractEntities call for
      // the same consultation).
      expect(call.common.idempotencyKey).toMatch(/^nlp:/);
      expect(call.common.idempotencyKey).not.toBe('nlp:consult-sync-1');
      expect(call.common).toMatchObject({
        tenantId: 'tenant-1',
        capability: 'NLP',
        operation: 'ner.extract',
        provider: 'built-in',
        model: 'blaze999/Medical-NER',
        deployment: 'SELF_HOSTED',
        consultationId: 'consult-sync-1',
      });
      expect(call.units).toEqual([
        { unit: 'TEXT_UNIT', quantity: 3 },
        { unit: 'REQUEST', quantity: 1 },
      ]);
    });

    it('carries a null model when AiTaskDefault resolution fail-opened', async () => {
      const usageLedger = createMockUsageLedger();
      const svc = buildServiceWithLedger(usageLedger); // no aiTaskDefaultService
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Test content', consultationId: 'consult-sync-2' }));
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { entities: [] } });

      await svc.extractEntities('ctx-item-123');

      const call = usageLedger.recordUsage.mock.calls[0][0];
      expect(call.common.model).toBeNull();
    });

    it('two extractEntities calls for the SAME consultation get DISTINCT idempotencyKeys (never dropped)', async () => {
      // Regression test for the earlier consultation-keyed design, which
      // silently dropped every call after the first for a consultation.
      const usageLedger = createMockUsageLedger();
      const svc = buildServiceWithLedger(usageLedger);
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Test content', consultationId: 'shared-consult' }));
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { entities: [] } });

      await svc.extractEntities('ctx-item-123');
      await svc.extractEntities('ctx-item-123');

      expect(usageLedger.recordUsage).toHaveBeenCalledTimes(2);
      const firstKey = usageLedger.recordUsage.mock.calls[0][0].common.idempotencyKey;
      const secondKey = usageLedger.recordUsage.mock.calls[1][0].common.idempotencyKey;
      expect(firstKey).not.toBe(secondKey);
      // Both still attribute to the same consultation.
      expect(usageLedger.recordUsage.mock.calls[0][0].common.consultationId).toBe('shared-consult');
      expect(usageLedger.recordUsage.mock.calls[1][0].common.consultationId).toBe('shared-consult');
    });

    it('emits nothing when IUsageLedgerService is absent (fail-open, existing positional fixtures unaffected)', async () => {
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Test content' }));
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { entities: [] } });

      // `service` (the shared beforeEach fixture) has no usageLedger — must not throw.
      await expect(service.extractEntities('ctx-item-123')).resolves.toBeUndefined();
    });

    it('a metering failure never fails extractEntities (never let a metering failure fail the request)', async () => {
      const usageLedger = { recordUsage: vi.fn().mockRejectedValue(new Error('outbox write failed')) };
      const svc = buildServiceWithLedger(usageLedger);
      mockContextItemRepository.findById.mockResolvedValue(createMockContextItem({ content: 'Test content' }));
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { entities: [] } });

      await expect(svc.extractEntities('ctx-item-123')).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // TASK-704 — Generator Entry-Point Seam
  // ===========================================================================
  describe('TASK-704 NoteGenerationService seam', () => {
    const createMockNoteGenerationService = () => ({
      generate: vi.fn(),
      resolveConfig: vi.fn(),
    });

    const buildServiceWithSeam = (noteGenerationService: ReturnType<typeof createMockNoteGenerationService> | undefined) =>
      new SummaryService(
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
        undefined, // harnessGatewayService
        mockHarnessPolicyService as any,
        undefined, // configResolver
        undefined, // entitlements
        undefined, // trajectoryService
        undefined, // aiTaskDefaultService
        undefined, // transcriptSegmentRepository
        undefined, // usageLedger
        undefined, // unitOfWork
        undefined, // billing
        undefined, // departmentAgentRepository
        undefined, // aiModelRepository
        noteGenerationService as any,
      );

    const primeGeneratePreSummaryMocks = () => {
      mockConsultationRepository.findById.mockResolvedValue(consultationFixture({ id: 'c-1', tenantId: 'tenant-1' }));
      mockContextItemRepository.findCaseNotes.mockResolvedValue([{ id: 'note-1', content: 'case note text' }]);
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });
      mockContextItemRepository.create.mockResolvedValue({ id: 'presummary-1', content: 'S', createdAt: new Date(), updatedAt: new Date() });
      mockSummaryMetaRepository.create.mockResolvedValue({ id: 'meta-1' });
    };

    it('generatePreSummary calls the seam (PRE_SUMMARY has no harness equivalent — logging-only, never blocks generation)', async () => {
      const mockNoteGenerationService = createMockNoteGenerationService();
      mockNoteGenerationService.generate.mockResolvedValue({ generator: 'legacy', reason: 'harness-not-supported-for-trigger' });
      const svc = buildServiceWithSeam(mockNoteGenerationService);
      primeGeneratePreSummaryMocks();

      const result = await svc.generatePreSummary('c-1', {});

      expect(mockNoteGenerationService.generate).toHaveBeenCalledWith(
        'PRE_SUMMARY',
        expect.objectContaining({ consultationId: 'c-1', tenantId: 'tenant-1' }),
      );
      expect(result).toBeDefined();
    });

    it('generatePreSummary still generates when the seam call fails (best-effort, non-blocking)', async () => {
      const mockNoteGenerationService = createMockNoteGenerationService();
      mockNoteGenerationService.generate.mockRejectedValue(new Error('seam unavailable'));
      const svc = buildServiceWithSeam(mockNoteGenerationService);
      primeGeneratePreSummaryMocks();

      await expect(svc.generatePreSummary('c-1', {})).resolves.toBeDefined();
    });

    it('generatePreSummary generates unaffected when noteGenerationService is not wired (pre-TASK-704 fixtures)', async () => {
      const svc = buildServiceWithSeam(undefined);
      primeGeneratePreSummaryMocks();

      await expect(svc.generatePreSummary('c-1', {})).resolves.toBeDefined();
    });

    // HUMAN-GATED (ticket README §6): generateSummary deliberately does NOT
    // call `generate()` — it would start a real harness workflow as a side
    // effect on top of the legacy call this route always still runs. Only
    // the side-effect-free `resolveConfig` read is exercised, for logging.
    describe('generateSummary (HUMAN-GATED — logging-only, sync semantics unchanged)', () => {
      const primeGenerateSummaryMocks = () => {
        mockConsultationRepository.findById.mockResolvedValue(consultationFixture({ id: 'c-1', tenantId: 'tenant-1' }));
        mockContextItemRepository.findTranscripts.mockResolvedValue([{ content: 'transcript text' }]);
        mockHttpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });
        mockContextItemRepository.create.mockResolvedValue({ id: 'ctx-new', content: 'S', createdAt: new Date(), updatedAt: new Date() });
        mockSummaryMetaRepository.create.mockResolvedValue({ id: 'meta-1' });
      };

      it('calls resolveConfig (read-only) but NEVER generate() — no live harness-start side effect', async () => {
        const mockNoteGenerationService = createMockNoteGenerationService();
        mockNoteGenerationService.resolveConfig.mockResolvedValue({ autoSummaryEnabled: true, autoNerEnabled: true, harnessEnabled: true });
        const svc = buildServiceWithSeam(mockNoteGenerationService);
        primeGenerateSummaryMocks();

        await svc.generateSummary('c-1', {});

        expect(mockNoteGenerationService.resolveConfig).toHaveBeenCalledWith('c-1');
        expect(mockNoteGenerationService.generate).not.toHaveBeenCalled();
      });

      it('always still runs legacy generation regardless of the resolved harnessEnabled value (sync semantics unchanged)', async () => {
        const mockNoteGenerationService = createMockNoteGenerationService();
        mockNoteGenerationService.resolveConfig.mockResolvedValue({ autoSummaryEnabled: true, autoNerEnabled: true, harnessEnabled: true });
        const svc = buildServiceWithSeam(mockNoteGenerationService);
        primeGenerateSummaryMocks();

        const result = await svc.generateSummary('c-1', {});

        expect(result).toBeDefined();
        expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
      });

      it('generates unaffected when the resolveConfig call itself fails (best-effort, non-blocking)', async () => {
        const mockNoteGenerationService = createMockNoteGenerationService();
        mockNoteGenerationService.resolveConfig.mockRejectedValue(new Error('seam unavailable'));
        const svc = buildServiceWithSeam(mockNoteGenerationService);
        primeGenerateSummaryMocks();

        await expect(svc.generateSummary('c-1', {})).resolves.toBeDefined();
      });

      it('generates unaffected when noteGenerationService is not wired (pre-TASK-704 fixtures)', async () => {
        const svc = buildServiceWithSeam(undefined);
        primeGenerateSummaryMocks();

        await expect(svc.generateSummary('c-1', {})).resolves.toBeDefined();
      });
    });
  });
});
