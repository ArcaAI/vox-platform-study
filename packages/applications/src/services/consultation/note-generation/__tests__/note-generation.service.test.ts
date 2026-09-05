/**
 * NoteGenerationService — (Generator Entry-Point Seam) unit tests.
 *
 * TASK-882: `pipeline.harnessEnabled` is gone (`false` routed to a legacy generator that no
 * longer existed), so the seam's one decision is whether the TRIGGER has a harness equivalent.
 *
 *   (a) TRANSCRIPTION_CREATED + gateway present → gateway.start() called, decision 'harness'.
 *   (b) TRANSCRIPTION_CREATED + gateway UNDEFINED → throws (regression test).
 *   (c) SUMMARY_REGENERATE mirrors (a)/(b).
 *   (d) PRE_SUMMARY / COMPREHENSIVE_SUMMARY → always legacy, 'harness-not-supported-for-trigger', no throw.
 *   (e) resolveConfig: auto-summary is the assigned workflow's generation node, with the
 *       per-consultation metadata override on top.
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

const createMockConfigResolver = (autoSummaryEnabled: boolean) => ({
  resolveAutoSummaryEnabled: vi.fn().mockResolvedValue(autoSummaryEnabled),
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

  const buildService = (gateway: unknown, autoSummaryEnabled = true) => {
    const mockConfigResolver = createMockConfigResolver(autoSummaryEnabled);
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

  describe('TRANSCRIPTION_CREATED', () => {
    it('(a) routes to harness and calls gateway.start with the harness context', async () => {
      const { service } = buildService(mockHarnessGateway);

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

    it('(b) THROWS rather than succeeding silently when HarnessGatewayService is undefined (§2.3 regression test)', async () => {
      const { service } = buildService(undefined);

      await expect(service.generate(GenerationTrigger.TRANSCRIPTION_CREATED, baseParams)).rejects.toThrow();
    });

    it('(f) threads the consultation patientId as externalPatientId (consent-abac Phase 4)', async () => {
      mockConsultationRepository.findById.mockResolvedValue({
        id: 'consultation-001',
        tenantId: 'tenant-abc',
        departmentId: 'dept-card-001',
        doctorId: 'dr-smith-001',
        patientId: 'patient-42',
        metadata: null,
      });
      const { service } = buildService(mockHarnessGateway);

      await service.generate(GenerationTrigger.TRANSCRIPTION_CREATED, baseParams);

      expect(mockHarnessGateway.start).toHaveBeenCalledWith('consultation-001', expect.objectContaining({ externalPatientId: 'patient-42' }));
    });

    it('(g) a patientId lookup failure is best-effort — generation still proceeds with externalPatientId undefined', async () => {
      mockConsultationRepository.findById.mockRejectedValue(new Error('DB down'));
      const { service } = buildService(mockHarnessGateway);

      const decision = await service.generate(GenerationTrigger.TRANSCRIPTION_CREATED, baseParams);

      expect(decision.generator).toBe('harness');
      expect(mockHarnessGateway.start).toHaveBeenCalledWith('consultation-001', expect.not.objectContaining({ externalPatientId: expect.anything() }));
    });
  });

  describe('SUMMARY_REGENERATE', () => {
    it('routes to harness', async () => {
      const { service } = buildService(mockHarnessGateway);

      const decision = await service.generate(GenerationTrigger.SUMMARY_REGENERATE, baseParams);

      expect(mockHarnessGateway.start).toHaveBeenCalledTimes(1);
      expect(decision).toEqual({ generator: 'harness', harnessJobId: expect.any(String) });
    });

    it('THROWS when HarnessGatewayService is undefined', async () => {
      const { service } = buildService(undefined);

      await expect(service.generate(GenerationTrigger.SUMMARY_REGENERATE, baseParams)).rejects.toThrow();
    });
  });

  describe('PRE_SUMMARY (no harness equivalent)', () => {
    it('always falls back to legacy with harness-not-supported-for-trigger', async () => {
      const { service } = buildService(mockHarnessGateway);

      const decision = await service.generate(GenerationTrigger.PRE_SUMMARY, baseParams);

      expect(decision).toEqual({ generator: 'legacy', reason: 'harness-not-supported-for-trigger' });
      expect(mockHarnessGateway.start).not.toHaveBeenCalled();
    });

    it('does not throw even when the gateway is undefined (never reached)', async () => {
      const { service } = buildService(undefined);

      await expect(service.generate(GenerationTrigger.PRE_SUMMARY, baseParams)).resolves.toEqual({
        generator: 'legacy',
        reason: 'harness-not-supported-for-trigger',
      });
    });
  });

  describe('COMPREHENSIVE_SUMMARY (no harness equivalent)', () => {
    it('always falls back to legacy with harness-not-supported-for-trigger', async () => {
      const { service } = buildService(mockHarnessGateway);

      const decision = await service.generate(GenerationTrigger.COMPREHENSIVE_SUMMARY, baseParams);

      expect(decision).toEqual({ generator: 'legacy', reason: 'harness-not-supported-for-trigger' });
      expect(mockHarnessGateway.start).not.toHaveBeenCalled();
    });

    it('does not throw even when the gateway is undefined (never reached)', async () => {
      const { service } = buildService(undefined);

      await expect(service.generate(GenerationTrigger.COMPREHENSIVE_SUMMARY, baseParams)).resolves.toEqual({
        generator: 'legacy',
        reason: 'harness-not-supported-for-trigger',
      });
    });
  });

  describe('resolveConfig', () => {
    it('returns default config when consultation not found', async () => {
      mockConsultationRepository.findById.mockResolvedValue(null);
      const { service } = buildService(mockHarnessGateway);

      const config = await service.resolveConfig('missing-id');

      expect(config.autoSummaryEnabled).toBe(true);
      expect(config.haltOnFailure).toBe(false);
    });

    it('returns default config on repository error', async () => {
      mockConsultationRepository.findById.mockRejectedValue(new Error('DB down'));
      const { service } = buildService(mockHarnessGateway);

      const config = await service.resolveConfig('c1');

      expect(config.autoSummaryEnabled).toBe(true);
    });

    it('auto-summary is the assigned workflow`s generation node (TASK-882)', async () => {
      const { service, mockConfigResolver } = buildService(mockHarnessGateway, false);

      const config = await service.resolveConfig('consultation-001');

      expect(config.autoSummaryEnabled).toBe(false);
      expect(mockConfigResolver.resolveAutoSummaryEnabled).toHaveBeenCalledWith({
        tenantId: 'tenant-abc',
        departmentId: 'dept-card-001',
        doctorId: 'dr-smith-001',
      });
    });

    it('lets a per-consultation metadata override beat the graph', async () => {
      mockConsultationRepository.findById.mockResolvedValue({
        id: 'c1',
        tenantId: 'tenant-abc',
        metadata: { pipelineConfig: { autoSummaryEnabled: true } },
      });
      const { service } = buildService(mockHarnessGateway, false);

      const config = await service.resolveConfig('c1');

      expect(config.autoSummaryEnabled).toBe(true);
    });

    it('an unwired resolver answers the code default', async () => {
      const service = new NoteGenerationService(mockConsultationRepository as any, mockHarnessGateway as any, mockEventEmitter as any, mockClsService as any);

      const config = await service.resolveConfig('consultation-001');

      expect(config.autoSummaryEnabled).toBe(true);
    });
  });
});
