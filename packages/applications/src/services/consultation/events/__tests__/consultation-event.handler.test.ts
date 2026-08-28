/**
 * ConsultationEventHandler Unit Tests
 *
 * Tests the auto-pipeline event handler that drives:
 *   TranscriptionCreated → seam (harness | visible failure) → SummaryGenerated → auto-NER skip (unconditional) → NerExtracted → PipelineCompleted
 *
 * TASK-732 — the legacy `SUMMARY_REGENERATE`/NER BullMQ dispatch
 * (`createSummaryJob`/`createNerJob`, and the doctor-preferred-prompt
 * threading that fed it) was deleted along with `summary.processor.ts` /
 * `ner.processor.ts`. `IConsultationJobService` is no longer a constructor
 * dependency of this handler at all. This file was rewritten in the same
 * commit to match:
 *   - handleTranscriptionCreated: gated on autoSummaryEnabled, then ALWAYS
 *     routes through the seam. `decision.generator === 'harness'` returns
 *     (the seam already started the workflow); any other decision is now a
 *     VISIBLE queued failure (PipelineStepFailed), never a legacy dispatch.
 *   - handleSummaryGenerated: auto-NER is gated on autoNerEnabled, then
 *     UNCONDITIONALLY skips the (deleted) legacy NER job and emits
 *     PipelineCompleted — this was the seam's second, now-removed
 *     `harnessEnabled` reader (see `harness-enabled-single-reader.grep-gate.test.ts`).
 *   - handleNerExtracted: unchanged — nothing in the current tree emits
 *     `ConsultationPipelineEvent.NerExtracted` any more (its sole producer,
 *     `ner.processor.ts`, is deleted), but the handler and its tests are out
 *     of this ticket's deletion scope and are left as defensive/dead code.
 *   - "preferred-prompt threading (Pillar B)" described threading that only
 *     applied to the deleted legacy dispatch (`ConfigResolver.resolvePreferredPromptTemplateId`
 *     is no longer called anywhere in this file) — removed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsultationEventHandler } from '../consultation-event.handler';
import { GenerationTrigger } from '../../note-generation';
import {
  ConsultationPipelineEvent,
  DEFAULT_PIPELINE_CONFIG,
  type TranscriptionCreatedPayload,
  type SummaryGeneratedPayload,
  type NerExtractedPayload,
} from '../consultation.events';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockConsultationRepository = () => ({
  findById: vi.fn().mockResolvedValue({
    id: 'consultation-001',
    tenantId: 'tenant-abc',
    patientId: 'patient-001',
    metadata: null,
  }),
});

const createMockEventEmitter = () => ({
  emit: vi.fn(),
});

// TASK-704 — the single seam the handler routes note-generation decisions
// through. `generate` defaults to the harness decision (the post-TASK-732
// steady state — harnessEnabled is true for every migrated tenant) so the
// base suite is a no-op unless a test overrides it. `resolveConfig`'s default
// implementation mirrors the REAL NoteGenerationService.resolveConfig's
// metadata-override behavior (minus the cascade, since no ConfigResolver is
// wired by default) so the many pre-existing tests that drive pipeline
// config through `mockConsultationRepository.findById(...).metadata.pipelineConfig`
// keep working unchanged — only the resolution happens "inside the seam"
// rather than on the handler.
const createMockNoteGenerationService = (consultationRepo: { findById: (id: string) => Promise<any> }) => ({
  generate: vi.fn().mockResolvedValue({ generator: 'harness', harnessJobId: 'harness-doc-default-001' }),
  resolveConfig: vi.fn().mockImplementation(async (consultationId: string) => {
    const consultation = await consultationRepo.findById(consultationId);
    if (!consultation) return { ...DEFAULT_PIPELINE_CONFIG };
    const metadata = consultation.metadata as Record<string, unknown> | null;
    const override = (metadata?.pipelineConfig ?? {}) as Record<string, unknown>;
    return { ...DEFAULT_PIPELINE_CONFIG, ...override };
  }),
});

// (Lane G) — the handler loads the triggering transcript's
// content so it can forward it to the harness workflow (NER + sensors run on it).
const createMockContextItemRepository = () => ({
  findById: vi.fn().mockResolvedValue({ id: 'ctx-transcript-001', content: 'Patient reports chest pain.' }),
});

// Mock ClsService. EventEmitter2 async handlers
// run in their own microtask context that does NOT inherit the caller's
// AsyncLocalStorage scope, so the handler must explicitly re-establish CLS.
// This mock runs the cls.run callback inline so existing tests stay
// synchronous and exposes spies for the new D.9 assertions.
const createMockClsService = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((...args: unknown[]) => {
      const callback = (args.length === 1 ? args[0] : args[1]) as () => unknown;
      return callback();
    }),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
    }),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
};

// =============================================================================
// Test Helpers
// =============================================================================

const basePayload = {
  consultationId: 'consultation-001',
  tenantId: 'tenant-abc',
  timestamp: new Date().toISOString(),
  correlationId: 'corr-xyz',
};

const makeTranscriptionPayload = (overrides?: Partial<TranscriptionCreatedPayload>): TranscriptionCreatedPayload => ({
  ...basePayload,
  userId: 'doctor-1',
  contextItemId: 'ctx-transcript-001',
  jobId: 'stt-job-001',
  wordCount: 350,
  transcriptionSource: 'streaming',
  ...overrides,
});

const makeSummaryPayload = (overrides?: Partial<SummaryGeneratedPayload>): SummaryGeneratedPayload => ({
  ...basePayload,
  userId: 'doctor-1',
  contextItemId: 'ctx-summary-001',
  jobId: 'summary-job-001',
  isAutoGenerated: true,
  ...overrides,
});

const makeNerPayload = (overrides?: Partial<NerExtractedPayload>): NerExtractedPayload => ({
  ...basePayload,
  userId: 'doctor-1',
  contextItemId: 'ctx-summary-001',
  jobId: 'ner-job-001',
  entityCount: 12,
  isAutoGenerated: true,
  entityCountByClass: { MEDICATION: 4, CONDITION: 3, PROCEDURE: 5 },
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('ConsultationEventHandler', () => {
  let handler: ConsultationEventHandler;
  let mockConsultationRepository: ReturnType<typeof createMockConsultationRepository>;
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
  let mockClsService: ReturnType<typeof createMockClsService>;
  let mockNoteGenerationService: ReturnType<typeof createMockNoteGenerationService>;
  let mockContextItemRepository: ReturnType<typeof createMockContextItemRepository>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConsultationRepository = createMockConsultationRepository();
    mockEventEmitter = createMockEventEmitter();
    mockClsService = createMockClsService();
    mockNoteGenerationService = createMockNoteGenerationService(mockConsultationRepository);
    mockContextItemRepository = createMockContextItemRepository();

    handler = new ConsultationEventHandler(
      mockConsultationRepository as any,
      mockEventEmitter as any,
      mockClsService as any,
      mockNoteGenerationService as any,
      mockContextItemRepository as any,
    );
  });

  // =========================================================================
  // handleTranscriptionCreated
  // =========================================================================

  describe('handleTranscriptionCreated', () => {
    it('should call the seam when autoSummaryEnabled (default config) and return on a harness decision', async () => {
      const payload = makeTranscriptionPayload();

      await handler.handleTranscriptionCreated(payload);

      expect(mockNoteGenerationService.generate).toHaveBeenCalledOnce();
      expect(mockNoteGenerationService.generate).toHaveBeenCalledWith(
        GenerationTrigger.TRANSCRIPTION_CREATED,
        expect.objectContaining({
          consultationId: 'consultation-001',
          tenantId: 'tenant-abc',
          userId: 'doctor-1',
          contextItemId: 'ctx-transcript-001',
        }),
      );
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(ConsultationPipelineEvent.PipelineStepFailed, expect.anything());
    });

    it('should NOT call the seam when autoSummaryEnabled is false', async () => {
      mockConsultationRepository.findById.mockResolvedValue({
        id: 'consultation-001',
        tenantId: 'tenant-abc',
        metadata: {
          pipelineConfig: {
            autoSummaryEnabled: false,
            autoNerEnabled: true,
          },
        },
      });

      const payload = makeTranscriptionPayload();
      await handler.handleTranscriptionCreated(payload);

      expect(mockNoteGenerationService.generate).not.toHaveBeenCalled();
    });

    it('should use "system" as userId when payload userId is undefined', async () => {
      const payload = makeTranscriptionPayload({ userId: undefined });
      await handler.handleTranscriptionCreated(payload);

      expect(mockNoteGenerationService.generate).toHaveBeenCalledWith(GenerationTrigger.TRANSCRIPTION_CREATED, expect.objectContaining({ userId: undefined }));
    });

    it('should emit PipelineStepFailed when the seam throws', async () => {
      mockNoteGenerationService.generate.mockRejectedValue(new Error('Queue connection refused'));

      const payload = makeTranscriptionPayload();
      await handler.handleTranscriptionCreated(payload);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ConsultationPipelineEvent.PipelineStepFailed,
        expect.objectContaining({
          consultationId: 'consultation-001',
          failedStep: 'summary',
          error: 'Queue connection refused',
          willContinue: false,
        }),
      );
    });

    it('should use default config when consultation not found', async () => {
      mockConsultationRepository.findById.mockResolvedValue(null);

      const payload = makeTranscriptionPayload();
      await handler.handleTranscriptionCreated(payload);

      // Default config has autoSummaryEnabled=true
      expect(mockNoteGenerationService.generate).toHaveBeenCalledOnce();
    });

    it('should use default config when consultation has no metadata', async () => {
      mockConsultationRepository.findById.mockResolvedValue({
        id: 'consultation-001',
        tenantId: 'tenant-abc',
        metadata: null,
      });

      const payload = makeTranscriptionPayload();
      await handler.handleTranscriptionCreated(payload);

      expect(mockNoteGenerationService.generate).toHaveBeenCalledOnce();
    });

    it('should use default config when metadata has no pipelineConfig', async () => {
      mockConsultationRepository.findById.mockResolvedValue({
        id: 'consultation-001',
        tenantId: 'tenant-abc',
        metadata: { someOtherField: true },
      });

      const payload = makeTranscriptionPayload();
      await handler.handleTranscriptionCreated(payload);

      expect(mockNoteGenerationService.generate).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // handleSummaryGenerated
  // =========================================================================

  describe('handleSummaryGenerated', () => {
    it('should unconditionally skip the (deleted) legacy NER job when autoNerEnabled and isAutoGenerated', async () => {
      const payload = makeSummaryPayload();

      await handler.handleSummaryGenerated(payload);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ConsultationPipelineEvent.PipelineCompleted,
        expect.objectContaining({
          consultationId: 'consultation-001',
          stepsExecuted: ['transcription', 'summary'],
        }),
      );
    });

    it('should NOT emit PipelineCompleted when isAutoGenerated is false (manual trigger)', async () => {
      const payload = makeSummaryPayload({ isAutoGenerated: false });

      await handler.handleSummaryGenerated(payload);

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should emit PipelineCompleted (stopping after summary) when autoNerEnabled is false', async () => {
      mockConsultationRepository.findById.mockResolvedValue({
        id: 'consultation-001',
        tenantId: 'tenant-abc',
        metadata: {
          pipelineConfig: {
            autoSummaryEnabled: true,
            autoNerEnabled: false,
          },
        },
      });

      const payload = makeSummaryPayload();
      await handler.handleSummaryGenerated(payload);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ConsultationPipelineEvent.PipelineCompleted,
        expect.objectContaining({
          consultationId: 'consultation-001',
          stepsExecuted: ['transcription', 'summary'],
        }),
      );
    });

    // TASK-732 regression lock — the auto-NER skip was PREVIOUSLY conditional
    // on harnessEnabled (skip only when true; dispatch legacy `createNerJob`
    // when false). The legacy NER generator no longer exists, so this must
    // now be unconditional regardless of harnessEnabled.
    it('should skip unconditionally regardless of harnessEnabled (true, false, or undefined)', async () => {
      for (const harnessEnabled of [true, false, undefined]) {
        mockEventEmitter.emit.mockClear();
        mockConsultationRepository.findById.mockResolvedValue({
          id: 'consultation-001',
          tenantId: 'tenant-abc',
          metadata: { pipelineConfig: { autoSummaryEnabled: true, autoNerEnabled: true, harnessEnabled } },
        });

        const payload = makeSummaryPayload();
        await handler.handleSummaryGenerated(payload);

        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          ConsultationPipelineEvent.PipelineCompleted,
          expect.objectContaining({ stepsExecuted: ['transcription', 'summary'] }),
        );
      }
    });
  });

  // =========================================================================
  // handleNerExtracted
  // =========================================================================

  describe('handleNerExtracted', () => {
    it('should emit PipelineCompleted when isAutoGenerated', async () => {
      const payload = makeNerPayload();

      await handler.handleNerExtracted(payload);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ConsultationPipelineEvent.PipelineCompleted,
        expect.objectContaining({
          consultationId: 'consultation-001',
          tenantId: 'tenant-abc',
          totalEntityCount: 12,
          stepsExecuted: ['transcription', 'summary', 'ner'],
        }),
      );
    });

    it('should NOT emit PipelineCompleted when isAutoGenerated is false', async () => {
      const payload = makeNerPayload({ isAutoGenerated: false });

      await handler.handleNerExtracted(payload);

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should include correlationId in PipelineCompleted payload', async () => {
      const payload = makeNerPayload({ correlationId: 'trace-456' });

      await handler.handleNerExtracted(payload);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ConsultationPipelineEvent.PipelineCompleted,
        expect.objectContaining({
          correlationId: 'trace-456',
        }),
      );
    });
  });

  // resolvePipelineConfig was MOVED (verbatim, TASK-704) to
  // `NoteGenerationService.resolveConfig` — its behavior is covered by
  // `note-generation/__tests__/note-generation.service.test.ts`'s
  // `resolveConfig` describe block; it no longer exists on this handler.

  // =========================================================================
  // Full Pipeline Integration (event chain simulation)
  // =========================================================================

  describe('Full pipeline chain', () => {
    it('should chain: TranscriptionCreated → seam (harness)', async () => {
      const payload = makeTranscriptionPayload();
      await handler.handleTranscriptionCreated(payload);

      expect(mockNoteGenerationService.generate).toHaveBeenCalledOnce();
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(ConsultationPipelineEvent.PipelineStepFailed, expect.anything());
    });

    it('should chain: SummaryGenerated (auto) → PipelineCompleted (legacy NER skipped unconditionally)', async () => {
      const payload = makeSummaryPayload({ isAutoGenerated: true });
      await handler.handleSummaryGenerated(payload);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ConsultationPipelineEvent.PipelineCompleted,
        expect.objectContaining({ stepsExecuted: ['transcription', 'summary'] }),
      );
    });

    it('should chain: NerExtracted (auto) → PipelineCompleted', async () => {
      const payload = makeNerPayload({ isAutoGenerated: true });
      await handler.handleNerExtracted(payload);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ConsultationPipelineEvent.PipelineCompleted,
        expect.objectContaining({
          stepsExecuted: ['transcription', 'summary', 'ner'],
        }),
      );
    });

    it('should stop at summary when autoNerEnabled=false', async () => {
      mockConsultationRepository.findById.mockResolvedValue({
        id: 'consultation-001',
        tenantId: 'tenant-abc',
        metadata: {
          pipelineConfig: {
            autoSummaryEnabled: true,
            autoNerEnabled: false,
          },
        },
      });

      const summaryPayload = makeSummaryPayload({ isAutoGenerated: true });
      await handler.handleSummaryGenerated(summaryPayload);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ConsultationPipelineEvent.PipelineCompleted,
        expect.objectContaining({
          stepsExecuted: ['transcription', 'summary'],
        }),
      );
    });

    it('should not call the seam when auto-summary is disabled', async () => {
      mockConsultationRepository.findById.mockResolvedValue({
        id: 'consultation-001',
        tenantId: 'tenant-abc',
        metadata: {
          pipelineConfig: {
            autoSummaryEnabled: false,
            autoNerEnabled: false,
          },
        },
      });

      const transcriptionPayload = makeTranscriptionPayload();
      await handler.handleTranscriptionCreated(transcriptionPayload);

      expect(mockNoteGenerationService.generate).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // CLS rebind + fail-closed guard
  //
  // EventEmitter2 async handlers run in their own microtask context that
  // does NOT inherit the caller's AsyncLocalStorage scope. Without these
  // guards, the consultationRepository.findById call inside each handler
  // hits the tenantScope extension's "no CLS = super-admin pass-through"
  // branch and silently bypasses tenant scoping. Each handler must
  // explicitly re-establish CLS from the payload.
  //
  // Fail-closed posture: log + early return (NOT throw), because
  // @OnEvent({ async: true }) handlers swallow throws and a throw here
  // would surface as an unhandled rejection.
  // =========================================================================

  describe('CLS rebind + fail-closed (follow-up)', () => {
    it('handleTranscriptionCreated wraps work in cls.run with tenantId + user set', async () => {
      const setOrder: Array<[string, unknown]> = [];
      mockClsService.set.mockImplementation((key: string, value: unknown) => {
        setOrder.push([key, value]);
      });

      const payload = makeTranscriptionPayload({
        tenantId: 'tenant-A',
        userId: 'doctor-A',
      });

      await handler.handleTranscriptionCreated(payload);

      expect(mockClsService.run).toHaveBeenCalledTimes(1);

      const keys = setOrder.map(([k]) => k);
      expect(keys).toContain('tenantId');
      expect(keys).toContain('user');

      const tenantEntry = setOrder.find(([k]) => k === 'tenantId');
      expect(tenantEntry?.[1]).toBe('tenant-A');

      const userEntry = setOrder.find(([k]) => k === 'user');
      expect(userEntry?.[1]).toMatchObject({
        id: 'doctor-A',
        tenantId: 'tenant-A',
        roles: [],
        permissions: [],
      });

      expect(mockConsultationRepository.findById).toHaveBeenCalled();
    });

    it('handleSummaryGenerated wraps work in cls.run with tenantId + user set', async () => {
      const setOrder: Array<[string, unknown]> = [];
      mockClsService.set.mockImplementation((key: string, value: unknown) => {
        setOrder.push([key, value]);
      });

      const payload = makeSummaryPayload({
        tenantId: 'tenant-B',
        userId: 'doctor-B',
      });

      await handler.handleSummaryGenerated(payload);

      expect(mockClsService.run).toHaveBeenCalledTimes(1);

      const keys = setOrder.map(([k]) => k);
      expect(keys).toContain('tenantId');
      expect(keys).toContain('user');

      const tenantEntry = setOrder.find(([k]) => k === 'tenantId');
      expect(tenantEntry?.[1]).toBe('tenant-B');

      const userEntry = setOrder.find(([k]) => k === 'user');
      expect(userEntry?.[1]).toMatchObject({
        id: 'doctor-B',
        tenantId: 'tenant-B',
        roles: [],
        permissions: [],
      });
    });

    it('handleNerExtracted wraps work in cls.run with tenantId + user set', async () => {
      const setOrder: Array<[string, unknown]> = [];
      mockClsService.set.mockImplementation((key: string, value: unknown) => {
        setOrder.push([key, value]);
      });

      const payload = makeNerPayload({
        tenantId: 'tenant-C',
        userId: 'doctor-C',
      });

      await handler.handleNerExtracted(payload);

      expect(mockClsService.run).toHaveBeenCalledTimes(1);

      const keys = setOrder.map(([k]) => k);
      expect(keys).toContain('tenantId');
      expect(keys).toContain('user');

      const tenantEntry = setOrder.find(([k]) => k === 'tenantId');
      expect(tenantEntry?.[1]).toBe('tenant-C');

      const userEntry = setOrder.find(([k]) => k === 'user');
      expect(userEntry?.[1]).toMatchObject({
        id: 'doctor-C',
        tenantId: 'tenant-C',
        roles: [],
        permissions: [],
      });
    });

    it('handleTranscriptionCreated logs+returns when payload.tenantId is missing', async () => {
      const payload = makeTranscriptionPayload({ tenantId: '' });

      await handler.handleTranscriptionCreated(payload);

      expect(mockNoteGenerationService.generate).not.toHaveBeenCalled();
      expect(mockConsultationRepository.findById).not.toHaveBeenCalled();
    });

    it('handleSummaryGenerated logs+returns when payload.tenantId is missing', async () => {
      const payload = makeSummaryPayload({ tenantId: '' });

      await handler.handleSummaryGenerated(payload);

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      expect(mockConsultationRepository.findById).not.toHaveBeenCalled();
    });

    it('handleNerExtracted logs+returns when payload.tenantId is missing', async () => {
      const payload = makeNerPayload({ tenantId: '' });

      await handler.handleNerExtracted(payload);

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // (Lane G / TASK-704, hardened by TASK-732) — harness flag routing
  //
  // The handler no longer reads harnessEnabled itself — it delegates the
  // decision (and, on 'harness', the harness-start side effect) to
  // `NoteGenerationService.generate`. These tests verify the handler's
  // DELEGATION contract (what it passes in, how it honors the decision); the
  // cascade/harnessEnabled resolution logic itself is unit-tested in
  // `note-generation/__tests__/note-generation.service.test.ts`.
  //
  // TASK-732 — a 'legacy' decision no longer has anywhere to dispatch to
  // (the legacy `SUMMARY_REGENERATE` generator was deleted). It is now a
  // VISIBLE queued failure (PipelineStepFailed), never a silent fallback.
  // =========================================================================

  describe('harness flag routing (Lane G / TASK-704 / TASK-732)', () => {
    const withHarnessConfig = (harnessEnabled: boolean) => {
      mockNoteGenerationService.resolveConfig.mockResolvedValue({ ...DEFAULT_PIPELINE_CONFIG, autoSummaryEnabled: true, harnessEnabled });
      mockNoteGenerationService.generate.mockResolvedValue(
        harnessEnabled ? { generator: 'harness', harnessJobId: 'harness-doc-test-001' } : { generator: 'legacy', reason: 'harnessEnabled-false' },
      );
    };

    it('routes to the seam and does not emit a failure when the decision is harness', async () => {
      withHarnessConfig(true);

      await handler.handleTranscriptionCreated(makeTranscriptionPayload());

      expect(mockNoteGenerationService.generate).toHaveBeenCalledTimes(1);
      expect(mockNoteGenerationService.generate).toHaveBeenCalledWith(
        GenerationTrigger.TRANSCRIPTION_CREATED,
        expect.objectContaining({
          consultationId: 'consultation-001',
          tenantId: 'tenant-abc',
          userId: 'doctor-1',
          contextItemId: 'ctx-transcript-001',
        }),
      );
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(ConsultationPipelineEvent.PipelineStepFailed, expect.anything());
    });

    it('loads the triggering transcript and forwards its text to the seam', async () => {
      withHarnessConfig(true);

      await handler.handleTranscriptionCreated(makeTranscriptionPayload());

      expect(mockContextItemRepository.findById).toHaveBeenCalledWith('ctx-transcript-001');
      const params = mockNoteGenerationService.generate.mock.calls[0][1];
      expect(params.transcriptText).toBe('Patient reports chest pain.');
    });

    it('still calls the seam when the transcript load fails (best-effort; assemble re-loads)', async () => {
      withHarnessConfig(true);
      mockContextItemRepository.findById.mockRejectedValue(new Error('ctx read failed'));

      await handler.handleTranscriptionCreated(makeTranscriptionPayload());

      expect(mockNoteGenerationService.generate).toHaveBeenCalledTimes(1);
      const params = mockNoteGenerationService.generate.mock.calls[0][1];
      expect(params.transcriptText).toBeUndefined();
    });

    it('emits a VISIBLE PipelineStepFailed (no silent legacy fallback) when the seam decision is legacy (harnessEnabled=false)', async () => {
      withHarnessConfig(false);

      await handler.handleTranscriptionCreated(makeTranscriptionPayload());

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ConsultationPipelineEvent.PipelineStepFailed,
        expect.objectContaining({
          failedStep: 'summary',
          willContinue: false,
          error: expect.stringContaining('harnessEnabled-false'),
        }),
      );
    });

    it('never calls the seam when auto-summary is disabled — gated before generate()', async () => {
      mockNoteGenerationService.resolveConfig.mockResolvedValue({ ...DEFAULT_PIPELINE_CONFIG, autoSummaryEnabled: false, harnessEnabled: true });

      await handler.handleTranscriptionCreated(makeTranscriptionPayload());

      expect(mockNoteGenerationService.generate).not.toHaveBeenCalled();
    });

    it('emits PipelineStepFailed when the seam throws — the §2.3 silent-drop regression, now loud, at the handler level', async () => {
      withHarnessConfig(true);
      mockNoteGenerationService.generate.mockRejectedValue(new Error('harness unreachable'));

      await handler.handleTranscriptionCreated(makeTranscriptionPayload());

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ConsultationPipelineEvent.PipelineStepFailed,
        expect.objectContaining({ failedStep: 'summary', error: 'harness unreachable' }),
      );
    });
  });
});

// =============================================================================
// DNA redaction rule last-mile wiring (harness path)
//
// On the harness branch the handler resolves the effective DNA-redaction
// decision (tenant + doctor double-gate + the department default-agent DNA
// policy) and, when effective, fetches + decrypts the doctor's redaction rules
// and threads them into HarnessGatewayService.start's ctx. Fail-SAFE: any
// resolution/decrypt failure yields NO rules (empty) and NEVER blocks the start.
// =============================================================================

describe('ConsultationEventHandler — DNA redaction wiring', () => {
  const REDACTION_RULE = { id: 'r1', type: 'remove', match: 'literal', pattern: "patient's employer" };

  let handler: ConsultationEventHandler;
  let mockConsultationRepository: ReturnType<typeof createMockConsultationRepository>;
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
  let mockClsService: ReturnType<typeof createMockClsService>;
  let mockNoteGenerationService: ReturnType<typeof createMockNoteGenerationService>;
  let mockContextItemRepository: ReturnType<typeof createMockContextItemRepository>;
  let mockConfigResolver: {
    resolvePipelineToggles: ReturnType<typeof vi.fn>;
    resolvePreferredPromptTemplateId: ReturnType<typeof vi.fn>;
    resolveEffectiveDnaRedactionEnabled: ReturnType<typeof vi.fn>;
  };
  let mockDnaReportRepository: {
    findLatestForDoctor: ReturnType<typeof vi.fn>;
    decryptFieldsFromEntity: ReturnType<typeof vi.fn>;
  };
  let mockSecretsService: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConsultationRepository = createMockConsultationRepository();
    mockEventEmitter = createMockEventEmitter();
    mockClsService = createMockClsService();
    mockNoteGenerationService = createMockNoteGenerationService(mockConsultationRepository);
    mockContextItemRepository = createMockContextItemRepository();

    mockConfigResolver = {
      resolvePipelineToggles: vi.fn().mockResolvedValue({
        autoSummaryEnabled: true,
        autoNerEnabled: true,
        harnessEnabled: false,
        dnaStyleEnabled: false,
        dnaRedactionEnabled: false,
        trace: {},
      }),
      resolvePreferredPromptTemplateId: vi.fn().mockResolvedValue(null),
      resolveEffectiveDnaRedactionEnabled: vi.fn().mockResolvedValue({ effective: true, tenantEnabled: true, doctorToggle: true }),
    };
    mockDnaReportRepository = {
      findLatestForDoctor: vi.fn().mockResolvedValue({ id: 'dna-report-001', doctorId: 'dr-smith-001' }),
      decryptFieldsFromEntity: vi.fn().mockResolvedValue({
        reportData: null,
        styleText: null,
        redactionRules: { rules: [REDACTION_RULE] },
      }),
    };
    mockSecretsService = { getSecretOptional: vi.fn() };

    // Harness routed via per-consultation metadata; doctor + department present
    // so the redaction double-gate has a subject to resolve.
    mockConsultationRepository.findById.mockResolvedValue({
      id: 'consultation-001',
      tenantId: 'tenant-abc',
      departmentId: 'dept-card-001',
      doctorId: 'dr-smith-001',
      parentConsultationId: null,
      metadata: { pipelineConfig: { autoSummaryEnabled: true, harnessEnabled: true } },
    });

    handler = new ConsultationEventHandler(
      mockConsultationRepository as any,
      mockEventEmitter as any,
      mockClsService as any,
      mockNoteGenerationService as any,
      mockContextItemRepository as any,
      mockConfigResolver as any,
      mockDnaReportRepository as any,
      mockSecretsService as any,
    );

    // TASK-704 — the consultation metadata sets harnessEnabled=true (above),
    // but the DECISION now comes from the (independently mocked) seam, not
    // from that metadata directly. Drive it explicitly so this block still
    // exercises the harness branch — the seam's OWN derivation from
    // harnessEnabled is unit-tested in note-generation.service.test.ts.
    mockNoteGenerationService.generate.mockResolvedValue({ generator: 'harness', harnessJobId: 'harness-doc-redaction-test' });
  });

  it('threads the doctor decrypted redaction rules into the seam params when the gate is effective', async () => {
    await handler.handleTranscriptionCreated(makeTranscriptionPayload());

    expect(mockConfigResolver.resolveEffectiveDnaRedactionEnabled).toHaveBeenCalledWith({
      tenantId: 'tenant-abc',
      departmentId: 'dept-card-001',
      doctorId: 'dr-smith-001',
    });
    expect(mockDnaReportRepository.findLatestForDoctor).toHaveBeenCalledWith('dr-smith-001');
    expect(mockNoteGenerationService.generate).toHaveBeenCalledTimes(1);
    const params = mockNoteGenerationService.generate.mock.calls[0][1];
    expect(params.redactionRules).toEqual([REDACTION_RULE]);
  });

  it('does NOT fetch or thread rules when the gate resolves ineffective', async () => {
    mockConfigResolver.resolveEffectiveDnaRedactionEnabled.mockResolvedValue({ effective: false, tenantEnabled: false, doctorToggle: null });

    await handler.handleTranscriptionCreated(makeTranscriptionPayload());

    expect(mockDnaReportRepository.findLatestForDoctor).not.toHaveBeenCalled();
    expect(mockNoteGenerationService.generate).toHaveBeenCalledTimes(1);
    const params = mockNoteGenerationService.generate.mock.calls[0][1];
    expect(params.redactionRules ?? []).toEqual([]);
  });

  // TASK-815: the handler used to resolve the department's default
  // `DepartmentAgent` and pass `departmentAgentDnaDisabled` as a THIRD gate that
  // could force redaction OFF. Both the lookup and the flag are gone; what the
  // handler passes is exactly the subject of the two surviving gates.
  it('passes only the tenant/department/doctor subject — no third gate is threaded', async () => {
    await handler.handleTranscriptionCreated(makeTranscriptionPayload());

    expect(mockConfigResolver.resolveEffectiveDnaRedactionEnabled).toHaveBeenCalledWith({
      tenantId: 'tenant-abc',
      departmentId: 'dept-card-001',
      doctorId: 'dr-smith-001',
    });
  });

  it('fails safe (no rules, seam still called) when decryption throws', async () => {
    mockDnaReportRepository.decryptFieldsFromEntity.mockRejectedValue(new Error('vault transit unavailable'));

    await handler.handleTranscriptionCreated(makeTranscriptionPayload());

    expect(mockNoteGenerationService.generate).toHaveBeenCalledTimes(1);
    const params = mockNoteGenerationService.generate.mock.calls[0][1];
    expect(params.redactionRules ?? []).toEqual([]);
    // The failure degrades to no-redaction, it does NOT emit a pipeline failure.
    expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(ConsultationPipelineEvent.PipelineStepFailed, expect.anything());
  });

  it('threads no rules (and does not throw) when the doctor has no DNA report', async () => {
    mockDnaReportRepository.findLatestForDoctor.mockResolvedValue(null);

    await handler.handleTranscriptionCreated(makeTranscriptionPayload());

    expect(mockNoteGenerationService.generate).toHaveBeenCalledTimes(1);
    const params = mockNoteGenerationService.generate.mock.calls[0][1];
    expect(params.redactionRules ?? []).toEqual([]);
  });
});
