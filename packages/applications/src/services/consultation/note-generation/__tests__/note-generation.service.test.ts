/**
 * NoteGenerationService — TASK-704 (Generator Entry-Point Seam) unit tests.
 *
 * Covers the seam's dispatch contract:
 *   (a) TRANSCRIPTION_CREATED + harnessEnabled=true + gateway present → gateway.start() called, decision 'harness'.
 *   (b) TRANSCRIPTION_CREATED + harnessEnabled=false → legacy decision, gateway never called.
 *   (c) TRANSCRIPTION_CREATED + harnessEnabled=true + gateway UNDEFINED → throws (§2.3 regression test).
 *   (d) SUMMARY_REGENERATE mirrors (a)/(b)/(c).
 *   (e) PRE_SUMMARY / COMPREHENSIVE_SUMMARY + harnessEnabled=true → always legacy, 'harness-not-supported-for-trigger', no throw.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NoteGenerationService } from '../note-generation.service';
import { GenerationTrigger } from '../types';

const createMockConsultationRepository = () => ({
  findById: vi.fn().mockResolvedValue({
    id: 'consultation-001',
    tenantId: 'tenant-abc',
    departmentId: 'dept-card-001',
    doctorId: 'dr-smith-001',
    metadata: null,
  }),
});

const createMockHarnessGatewayService = () => ({
  start: vi.fn().mockResolvedValue({ workflowId: 'harness-wf-001' }),
});

const createMockConfigResolver = (harnessEnabled: boolean) => ({
  resolvePipelineToggles: vi.fn().mockResolvedValue({
    autoSummaryEnabled: true,
    autoNerEnabled: true,
    harnessEnabled,
    dnaStyleEnabled: false,
    dnaRedactionEnabled: false,
    trace: {},
  }),
  resolvePreferredPromptTemplateId: vi.fn().mockResolvedValue(null),
});

const createMockEventEmitter = () => ({ emit: vi.fn() });

const createMockClsService = () => ({
  run: vi.fn((...args: unknown[]) => (args.length === 1 ? args[0] : args[1])()),
  set: vi.fn(),
  get: vi.fn(),
});

const baseParams = {
  consultationId: 'consultation-001',
  tenantId: 'tenant-abc',
  userId: 'doctor-1',
  correlationId: 'corr-xyz',
  contextItemId: 'ctx-transcript-001',
  transcriptText: 'Patient reports chest pain.',
};

describe('NoteGenerationService', () => {
  let mockConsultationRepository: ReturnType<typeof createMockConsultationRepository>;
  let mockHarnessGateway: ReturnType<typeof createMockHarnessGatewayService>;
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
  let mockClsService: ReturnType<typeof createMockClsService>;

  const buildService = (harnessEnabled: boolean, gateway: unknown) => {
    const mockConfigResolver = createMockConfigResolver(harnessEnabled);
    return {
      service: new NoteGenerationService(
        mockConsultationRepository as any,
        gateway as any,
        mockEventEmitter as any,
        mockClsService as any,
        mockConfigResolver as any,
      ),
      mockConfigResolver,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConsultationRepository = createMockConsultationRepository();
    mockHarnessGateway = createMockHarnessGatewayService();
    mockEventEmitter = createMockEventEmitter();
    mockClsService = createMockClsService();
  });

  // ===========================================================================
  // (a)/(b)/(c) — TRANSCRIPTION_CREATED
  // ===========================================================================

  describe('TRANSCRIPTION_CREATED', () => {
    it('(a) routes to harness and calls gateway.start with the harness context when harnessEnabled=true', async () => {
      const { service } = buildService(true, mockHarnessGateway);

      const decision = await service.generate(GenerationTrigger.TRANSCRIPTION_CREATED, baseParams);

      expect(mockHarnessGateway.start).toHaveBeenCalledTimes(1);
      expect(mockHarnessGateway.start).toHaveBeenCalledWith(
        'consultation-001',
        expect.objectContaining({
          tenantId: 'tenant-abc',
          userId: 'doctor-1',
          contextItemId: 'ctx-transcript-001',
          transcriptText: 'Patient reports chest pain.',
          jobId: expect.any(String),
        }),
      );
      expect(decision).toEqual({ generator: 'harness', harnessJobId: expect.any(String) });
    });

    it('(b) returns a legacy decision and never calls the gateway when harnessEnabled=false', async () => {
      const { service } = buildService(false, mockHarnessGateway);

      const decision = await service.generate(GenerationTrigger.TRANSCRIPTION_CREATED, baseParams);

      expect(mockHarnessGateway.start).not.toHaveBeenCalled();
      expect(decision).toEqual({ generator: 'legacy', reason: 'harnessEnabled-false' });
    });

    it('(c) THROWS rather than succeeding silently when harnessEnabled=true and HarnessGatewayService is undefined (§2.3 regression test)', async () => {
      const { service } = buildService(true, undefined);

      await expect(service.generate(GenerationTrigger.TRANSCRIPTION_CREATED, baseParams)).rejects.toThrow();
    });

    it('(f) threads the consultation patientId as externalPatientId (TASK-712, consent-abac Phase 4)', async () => {
      mockConsultationRepository.findById.mockResolvedValue({
        id: 'consultation-001',
        tenantId: 'tenant-abc',
        departmentId: 'dept-card-001',
        doctorId: 'dr-smith-001',
        patientId: 'PAT-20250101-001',
        metadata: null,
      });
      const { service } = buildService(true, mockHarnessGateway);

      await service.generate(GenerationTrigger.TRANSCRIPTION_CREATED, baseParams);

      expect(mockHarnessGateway.start).toHaveBeenCalledWith(
        'consultation-001',
        expect.objectContaining({ externalPatientId: 'PAT-20250101-001' }),
      );
    });

    it('(g) a patientId lookup failure is best-effort — generation still proceeds with externalPatientId undefined', async () => {
      // First call is resolveConfig's own internal lookup (must succeed so
      // harnessEnabled resolves); the second is generate()'s dedicated
      // patientId lookup, which is the one that fails here.
      mockConsultationRepository.findById
        .mockResolvedValueOnce({
          id: 'consultation-001',
          tenantId: 'tenant-abc',
          departmentId: 'dept-card-001',
          doctorId: 'dr-smith-001',
          metadata: null,
        })
        .mockRejectedValueOnce(new Error('DB hiccup'));
      const { service } = buildService(true, mockHarnessGateway);

      const decision = await service.generate(GenerationTrigger.TRANSCRIPTION_CREATED, baseParams);

      expect(decision).toEqual({ generator: 'harness', harnessJobId: expect.any(String) });
      expect(mockHarnessGateway.start).toHaveBeenCalledWith(
        'consultation-001',
        expect.objectContaining({ externalPatientId: undefined }),
      );
    });
  });

  // ===========================================================================
  // (d) — SUMMARY_REGENERATE mirrors TRANSCRIPTION_CREATED
  // ===========================================================================

  describe('SUMMARY_REGENERATE', () => {
    it('routes to harness when harnessEnabled=true', async () => {
      const { service } = buildService(true, mockHarnessGateway);

      const decision = await service.generate(GenerationTrigger.SUMMARY_REGENERATE, baseParams);

      expect(mockHarnessGateway.start).toHaveBeenCalledTimes(1);
      expect(decision).toEqual({ generator: 'harness', harnessJobId: expect.any(String) });
    });

    it('returns a legacy decision when harnessEnabled=false', async () => {
      const { service } = buildService(false, mockHarnessGateway);

      const decision = await service.generate(GenerationTrigger.SUMMARY_REGENERATE, baseParams);

      expect(mockHarnessGateway.start).not.toHaveBeenCalled();
      expect(decision).toEqual({ generator: 'legacy', reason: 'harnessEnabled-false' });
    });

    it('THROWS when harnessEnabled=true and HarnessGatewayService is undefined', async () => {
      const { service } = buildService(true, undefined);

      await expect(service.generate(GenerationTrigger.SUMMARY_REGENERATE, baseParams)).rejects.toThrow();
    });
  });

  // ===========================================================================
  // (e) — PRE_SUMMARY / COMPREHENSIVE_SUMMARY: no harness equivalent exists.
  // Always a structured legacy fallback, logged, never a throw — even when
  // harnessEnabled=true and even when the gateway is undefined (the trigger
  // never reaches the gateway call at all).
  // ===========================================================================

  describe('PRE_SUMMARY (no harness equivalent)', () => {
    it('always falls back to legacy with harness-not-supported-for-trigger, even when harnessEnabled=true', async () => {
      const { service } = buildService(true, mockHarnessGateway);

      const decision = await service.generate(GenerationTrigger.PRE_SUMMARY, baseParams);

      expect(decision).toEqual({ generator: 'legacy', reason: 'harness-not-supported-for-trigger' });
      expect(mockHarnessGateway.start).not.toHaveBeenCalled();
    });

    it('does not throw even when the gateway is undefined (never reached)', async () => {
      const { service } = buildService(true, undefined);

      await expect(service.generate(GenerationTrigger.PRE_SUMMARY, baseParams)).resolves.toEqual({
        generator: 'legacy',
        reason: 'harness-not-supported-for-trigger',
      });
    });
  });

  describe('COMPREHENSIVE_SUMMARY (no harness equivalent)', () => {
    it('always falls back to legacy with harness-not-supported-for-trigger, even when harnessEnabled=true', async () => {
      const { service } = buildService(true, mockHarnessGateway);

      const decision = await service.generate(GenerationTrigger.COMPREHENSIVE_SUMMARY, baseParams);

      expect(decision).toEqual({ generator: 'legacy', reason: 'harness-not-supported-for-trigger' });
      expect(mockHarnessGateway.start).not.toHaveBeenCalled();
    });

    it('does not throw even when the gateway is undefined (never reached)', async () => {
      const { service } = buildService(true, undefined);

      await expect(service.generate(GenerationTrigger.COMPREHENSIVE_SUMMARY, baseParams)).resolves.toEqual({
        generator: 'legacy',
        reason: 'harness-not-supported-for-trigger',
      });
    });
  });

  // ===========================================================================
  // resolveConfig — moved verbatim from ConsultationEventHandler.resolvePipelineConfig
  // ===========================================================================

  describe('resolveConfig', () => {
    it('returns default config when consultation not found', async () => {
      mockConsultationRepository.findById.mockResolvedValue(null);
      const { service } = buildService(false, mockHarnessGateway);

      const config = await service.resolveConfig('missing-id');

      expect(config.autoSummaryEnabled).toBe(true);
      expect(config.autoNerEnabled).toBe(true);
    });

    it('returns default config on repository error', async () => {
      mockConsultationRepository.findById.mockRejectedValue(new Error('DB down'));
      const { service } = buildService(false, mockHarnessGateway);

      const config = await service.resolveConfig('c1');

      expect(config.autoSummaryEnabled).toBe(true);
      expect(config.haltOnFailure).toBe(false);
    });

    it('lets a per-consultation metadata override beat the cascade', async () => {
      mockConsultationRepository.findById.mockResolvedValue({
        id: 'c1',
        tenantId: 'tenant-abc',
        metadata: { pipelineConfig: { harnessEnabled: false } },
      });
      const { service } = buildService(true, mockHarnessGateway);

      const config = await service.resolveConfig('c1');

      expect(config.harnessEnabled).toBe(false);
    });

    it('surfaces the cascade-resolved harnessEnabled when no metadata override exists', async () => {
      const { service } = buildService(true, mockHarnessGateway);

      const config = await service.resolveConfig('consultation-001');

      expect(config.harnessEnabled).toBe(true);
    });
  });
});
