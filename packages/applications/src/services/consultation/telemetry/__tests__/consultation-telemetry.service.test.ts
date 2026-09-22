/**
 * ConsultationTelemetryService unit tests — TASK-999 Lane B.
 *
 * Every test below was RED before this lane: `ConsultationTelemetryService`,
 * `AiUsageEventRepository.findByConsultation`,
 * `ContextItemRepository.aggregateContentCounts` /
 * `.findLatestIdsByTypes` and `NamedEntityRepository.countByClassForConsultation`
 * did not exist, so the suite failed to import.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';
import { AgentSessionKind, AgentStepType, AiUsageUnit, SysEventType } from '@arcaai/domains';
import { ConsultationTelemetryService } from '../consultation-telemetry.service';

const TENANT = 'tenant-1';
const CONSULTATION = 'consultation-1';
const STARTED = new Date('2026-09-01T09:00:00.000Z');
const UPDATED = new Date('2026-09-01T09:42:00.000Z');

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockConsultationRepository = { findById: vi.fn() };
const mockContextItemRepository = { aggregateContentCounts: vi.fn(), findLatestIdsByTypes: vi.fn() };
const mockSummaryMetaRepository = { findByContextItem: vi.fn() };
const mockAiUsageEventRepository = { findByConsultation: vi.fn() };
const mockAgentTrajectoryStepRepository = { findByConsultation: vi.fn() };
const mockNamedEntityRepository = { countByClassForConsultation: vi.fn() };
const mockTranscriptionJobRepository = { findTelemetryByConsultation: vi.fn(), findByConsultation: vi.fn() };
const mockAppSettingsService = { getValueWithDefault: vi.fn() };

/** One usage-ledger unit row. Several sharing a `requestId` are ONE call. */
const ledgerRow = (over: Partial<Record<string, unknown>> = {}) => ({
  idempotencyKey: `idem-${Math.random()}`,
  requestId: 'req-1',
  operation: 'generate',
  provider: 'lmstudio',
  model: null,
  unit: AiUsageUnit.INPUT_TOKEN,
  quantity: 0,
  ...over,
});

const trajectoryStep = (over: Partial<Record<string, unknown>> = {}) => ({
  sessionKind: AgentSessionKind.LIVE_DOC,
  stepType: AgentStepType.LLM_CALL,
  name: 'flush',
  durationMs: 400,
  stats: { prompt_tokens: 100, completion_tokens: 20, model: 'gemma3' },
  ...over,
});

const buildService = (withSettings = true) =>
  new ConsultationTelemetryService(
    mockConsultationRepository as any,
    mockContextItemRepository as any,
    mockSummaryMetaRepository as any,
    mockAiUsageEventRepository as any,
    mockAgentTrajectoryStepRepository as any,
    mockNamedEntityRepository as any,
    mockTranscriptionJobRepository as any,
    mockEventEmitter as any,
    mockClsService as any,
    withSettings ? (mockAppSettingsService as any) : undefined,
  );

/** The "nothing happened anywhere" baseline every test starts from. */
const resetToEmpty = () => {
  mockConsultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: TENANT, createdAt: STARTED, updatedAt: UPDATED });
  mockContextItemRepository.aggregateContentCounts.mockResolvedValue({ count: 0, measuredCount: 0, wordCount: null, charCount: null });
  mockContextItemRepository.findLatestIdsByTypes.mockResolvedValue({});
  mockSummaryMetaRepository.findByContextItem.mockResolvedValue(null);
  mockAiUsageEventRepository.findByConsultation.mockResolvedValue([]);
  mockAgentTrajectoryStepRepository.findByConsultation.mockResolvedValue([]);
  mockNamedEntityRepository.countByClassForConsultation.mockResolvedValue({});
  mockTranscriptionJobRepository.findTelemetryByConsultation.mockResolvedValue([]);
  mockAppSettingsService.getValueWithDefault.mockImplementation((_key: string, fallback: unknown) => fallback);
};

describe('ConsultationTelemetryService', () => {
  let service: ConsultationTelemetryService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return TENANT;
      if (key === 'user') return { id: 'user-1' };
      return null;
    });
    resetToEmpty();
    service = buildService();
  });

  describe('a consultation with full activity', () => {
    // RED before this lane: no service existed to aggregate any of it.
    it('returns every block available with correct aggregates', async () => {
      mockContextItemRepository.aggregateContentCounts.mockResolvedValue({ count: 3, measuredCount: 3, wordCount: 300, charCount: 1800 });
      mockContextItemRepository.findLatestIdsByTypes.mockResolvedValue({
        PRE_SUMMARY: 'ctx-pre',
        RAW_SUMMARY: 'ctx-raw',
        MODIFIED_SUMMARY: 'ctx-mod',
      });
      mockSummaryMetaRepository.findByContextItem.mockImplementation(async (id: string) =>
        id === 'ctx-pre'
          ? { inputTokens: 900, outputTokens: 120, modelName: 'gemma3-pre', processingTimeMs: 1500 }
          : { inputTokens: 2400, outputTokens: 600, modelName: 'gemma3-final', processingTimeMs: 8200 },
      );
      mockNamedEntityRepository.countByClassForConsultation.mockResolvedValue({ MEDICATION: 4, CONDITION: 2 });
      mockAgentTrajectoryStepRepository.findByConsultation.mockResolvedValue([
        trajectoryStep({ durationMs: 400 }),
        trajectoryStep({ name: 'flush.repair', durationMs: 600, stats: { prompt_tokens: 50, completion_tokens: 10, model: 'gemma3' } }),
      ]);
      mockTranscriptionJobRepository.findTelemetryByConsultation.mockResolvedValue([
        { resultWordCount: 820, resultCharCount: 4900, servedBy: { modelSlug: 'whisper-ml-en', provider: 'whisper-cpp', chainIndex: 0, source: 'primary' } },
      ]);
      mockAiUsageEventRepository.findByConsultation.mockResolvedValue([
        // transcription
        ledgerRow({ requestId: 'req-stt', operation: 'transcribe.stream', provider: 'whisper-cpp', unit: AiUsageUnit.AUDIO_SECOND, quantity: 90 }),
        // pre-summary + final summary providers
        ledgerRow({ requestId: 'req-pre', operation: 'presummarize', provider: 'lmstudio', unit: AiUsageUnit.INPUT_TOKEN, quantity: 900 }),
        ledgerRow({ requestId: 'req-final', operation: 'generate', provider: 'lmstudio', unit: AiUsageUnit.INPUT_TOKEN, quantity: 2400 }),
        // NER: one call, one compute row carrying its duration
        ledgerRow({ requestId: 'req-ner', operation: 'ner.extract', provider: 'nlp', unit: AiUsageUnit.REQUEST, quantity: 1 }),
        ledgerRow({ requestId: 'req-ner', operation: 'ner.extract', provider: 'nlp', unit: AiUsageUnit.GPU_SECOND, quantity: 1.25 }),
        // guardrail: one call, two token rows
        ledgerRow({ requestId: 'req-guard', operation: 'guardrail.validate', provider: 'granite', model: 'granite-guardian', unit: AiUsageUnit.INPUT_TOKEN, quantity: 400 }),
        ledgerRow({ requestId: 'req-guard', operation: 'guardrail.validate', provider: 'granite', model: 'granite-guardian', unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 12 }),
      ]);

      const result = await service.getTelemetry(CONSULTATION);

      expect(result.consultationId).toBe(CONSULTATION);
      for (const key of ['session', 'caseNotes', 'transcription', 'preSummary', 'partialSummary', 'finalSummary', 'ner', 'guardrail'] as const) {
        expect(result[key].available, `${key} should be available`).toBe(true);
      }

      expect(result.session.data).toEqual({
        startedAt: STARTED.toISOString(),
        lastActivityAt: UPDATED.toISOString(),
        durationMs: 42 * 60 * 1000,
      });
      expect(result.caseNotes.data).toEqual({ count: 3, measuredCount: 3, wordCount: 300, charCount: 1800 });

      // 90 audio seconds → ms; model/provider from the job that ACTUALLY served.
      expect(result.transcription.data).toMatchObject({ jobCount: 1, durationMs: 90_000, wordCount: 820, charCount: 4900, model: 'whisper-ml-en', provider: 'whisper-cpp' });

      expect(result.preSummary.data).toEqual({ inputTokens: 900, outputTokens: 120, model: 'gemma3-pre', provider: 'lmstudio', durationMs: 1500 });

      // MODIFIED_SUMMARY wins over RAW_SUMMARY when both exist.
      expect(mockSummaryMetaRepository.findByContextItem).toHaveBeenCalledWith('ctx-mod');
      expect(mockSummaryMetaRepository.findByContextItem).not.toHaveBeenCalledWith('ctx-raw');
      expect(result.finalSummary.data).toMatchObject({ inputTokens: 2400, outputTokens: 600, model: 'gemma3-final' });

      expect(result.partialSummary.data).toEqual({
        callCount: 2,
        inputTokens: 150,
        outputTokens: 30,
        models: ['gemma3'],
        provider: null,
        avgDurationMs: 500,
        totalDurationMs: 1000,
      });

      expect(result.ner.data).toMatchObject({ entityCount: 6, byLabel: { MEDICATION: 4, CONDITION: 2 }, callCount: 1 });

      // Two unit rows sharing `req-guard` are ONE call, not two.
      expect(result.guardrail.data).toEqual({
        callCount: 1,
        inputTokens: 400,
        outputTokens: 12,
        models: ['granite-guardian'],
        provider: 'granite',
        avgDurationMs: null,
        totalDurationMs: null,
      });
    });
  });

  describe('a consultation with no AI activity', () => {
    // RED before this lane: the endpoint did not exist, so "never throws on an
    // empty consultation" was unverifiable.
    it('returns available:false with NO_ACTIVITY everywhere and never throws', async () => {
      const result = await service.getTelemetry(CONSULTATION);

      // The session block is the one exception: a consultation that exists
      // always has its own two timestamps, so it is never "no activity".
      expect(result.session.available).toBe(true);

      for (const key of ['caseNotes', 'transcription', 'preSummary', 'partialSummary', 'finalSummary', 'ner', 'guardrail'] as const) {
        expect(result[key], `${key}`).toMatchObject({ available: false, reason: 'NO_ACTIVITY' });
        expect(result[key].data, `${key} must carry no data`).toBeUndefined();
      }
    });

    // RED: nothing distinguished "we do not capture it" from "there was none".
    it('answers NOT_RECORDED when a summary document exists but its SummaryMeta row does not', async () => {
      mockContextItemRepository.findLatestIdsByTypes.mockResolvedValue({ PRE_SUMMARY: 'ctx-pre' });
      mockSummaryMetaRepository.findByContextItem.mockResolvedValue(null);

      const result = await service.getTelemetry(CONSULTATION);

      expect(result.preSummary).toMatchObject({ available: false, source: 'summary-meta', reason: 'NOT_RECORDED' });
      // No document at all is still NO_ACTIVITY — the two are not merged.
      expect(result.finalSummary).toMatchObject({ available: false, reason: 'NO_ACTIVITY' });
    });

    // RED: without the retention read, a swept consultation was indistinguishable
    // from one that never ran a live flush.
    it('answers PRUNED, not NO_ACTIVITY, once retention is on and the consultation is past the window', async () => {
      mockConsultationRepository.findById.mockResolvedValue({
        id: CONSULTATION,
        tenantId: TENANT,
        createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      });
      mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, fallback: unknown) =>
        key === 'agentic.trajectory.enabled' ? true : fallback,
      );

      const result = await service.getTelemetry(CONSULTATION);

      expect(result.partialSummary).toMatchObject({ available: false, source: 'agent-trajectory', reason: 'PRUNED' });
    });

    // RED: retention OFF means nothing has been swept, so PRUNED would be a lie.
    it('stays NO_ACTIVITY for an old consultation while retention is disabled', async () => {
      mockConsultationRepository.findById.mockResolvedValue({
        id: CONSULTATION,
        tenantId: TENANT,
        createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      });

      const result = await service.getTelemetry(CONSULTATION);

      expect(result.partialSummary).toMatchObject({ available: false, reason: 'NO_ACTIVITY' });
    });
  });

  describe('case-note measurement', () => {
    // RED: nothing carried `measuredCount`, so three notes with one unmeasured
    // rendered as three notes whose totals silently covered only two.
    it('reports count and measuredCount apart and sums the measured subset only', async () => {
      // 3 notes, 1 with a NULL contentWordCount ⇒ the repository measures 2.
      mockContextItemRepository.aggregateContentCounts.mockResolvedValue({ count: 3, measuredCount: 2, wordCount: 180, charCount: 1100 });

      const result = await service.getTelemetry(CONSULTATION);

      expect(result.caseNotes).toMatchObject({ available: true, source: 'context-item' });
      expect(result.caseNotes.data).toEqual({ count: 3, measuredCount: 2, wordCount: 180, charCount: 1100 });
    });

    // RED: a body was never counted at read time, but nothing said so.
    it('keeps the totals NULL — not 0 — inside an available block when nothing was measured', async () => {
      mockContextItemRepository.aggregateContentCounts.mockResolvedValue({ count: 4, measuredCount: 0, wordCount: null, charCount: null });

      const result = await service.getTelemetry(CONSULTATION);

      expect(result.caseNotes.data).toEqual({ count: 4, measuredCount: 0, wordCount: null, charCount: null });
    });

    // RED before the fix: the transcription block read `findByConsultation`, whose rows
    // carry `encryptedResultText`/`encryptedResultMetadata` — so the base `db` decrypt-on-read
    // wrapper pulled every transcript body for the consultation through a Vault batch decrypt
    // as a SIDE EFFECT of reading three scalars for an admin pane.
    it('never reads transcription-job rows, so no transcript is decrypted to produce a count', async () => {
      await service.getTelemetry(CONSULTATION);

      expect(mockTranscriptionJobRepository.findTelemetryByConsultation).toHaveBeenCalledWith(CONSULTATION);
      expect(mockTranscriptionJobRepository.findByConsultation).not.toHaveBeenCalled();
    });

    // RED: the obvious implementation (`findCaseNotes().length`) pulls every
    // encrypted body through Vault to produce a number — TASK-999 D-3(a).
    it('never reads case-note rows, so no PHI is decrypted to produce a count', async () => {
      (mockContextItemRepository as any).findCaseNotes = vi.fn();
      (mockContextItemRepository as any).findByConsultation = vi.fn();

      await service.getTelemetry(CONSULTATION);

      expect((mockContextItemRepository as any).findCaseNotes).not.toHaveBeenCalled();
      expect((mockContextItemRepository as any).findByConsultation).not.toHaveBeenCalled();
      expect(mockContextItemRepository.aggregateContentCounts).toHaveBeenCalledWith(CONSULTATION, 'CASE_NOTE');
    });
  });

  describe('NER duration', () => {
    // RED: `NamedEntity.processingTimeMs` is stamped identically on every entity
    // of one call, so summing it multiplied one call's duration by its entity
    // count. The ledger's compute row is the only per-CALL measurement.
    it('comes from the usage-ledger compute rows, never from summing NamedEntity.processingTimeMs', async () => {
      mockNamedEntityRepository.countByClassForConsultation.mockResolvedValue({ MEDICATION: 5 });
      mockAiUsageEventRepository.findByConsultation.mockResolvedValue([
        ledgerRow({ requestId: 'req-ner', operation: 'ner.extract', provider: 'nlp', unit: AiUsageUnit.REQUEST, quantity: 1 }),
        // ONE call, 2.5 s of GPU occupancy. Five entities were produced; a SUM
        // over their per-entity processingTimeMs would report 5x this.
        ledgerRow({ requestId: 'req-ner', operation: 'ner.extract', provider: 'nlp', unit: AiUsageUnit.GPU_SECOND, quantity: 2.5 }),
      ]);

      // The row finder decrypts every entity's `text` through Vault; the
      // histogram must never reach for it.
      (mockNamedEntityRepository as any).findByConsultation = vi.fn();

      const result = await service.getTelemetry(CONSULTATION);

      expect(result.ner.data).toMatchObject({ entityCount: 5, callCount: 1, totalDurationMs: 2500 });
      // The entity repository is only ever asked for the label histogram.
      expect(mockNamedEntityRepository.countByClassForConsultation).toHaveBeenCalledWith(CONSULTATION);
      expect((mockNamedEntityRepository as any).findByConsultation).not.toHaveBeenCalled();
    });

    // RED: an unmeasured extraction rendered as 0 ms, i.e. "instant".
    it('reports a NULL duration when the ledger recorded no compute row', async () => {
      mockNamedEntityRepository.countByClassForConsultation.mockResolvedValue({ CONDITION: 2 });
      mockAiUsageEventRepository.findByConsultation.mockResolvedValue([
        ledgerRow({ requestId: 'req-ner', operation: 'ner.extract', provider: 'nlp', unit: AiUsageUnit.REQUEST, quantity: 1 }),
      ]);

      const result = await service.getTelemetry(CONSULTATION);

      expect(result.ner.data).toMatchObject({ callCount: 1, totalDurationMs: null });
    });
  });

  describe('tenancy', () => {
    // RED: no endpoint existed; the posture had to be asserted on arrival or it
    // would be 403 by accident the first time someone added an ownership check.
    it('answers NotFoundException — never Forbidden — for a cross-tenant consultation', async () => {
      mockConsultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: 'some-other-tenant', createdAt: STARTED, updatedAt: UPDATED });

      await expect(service.getTelemetry(CONSULTATION)).rejects.toThrow(NotFoundException);
    });

    // RED: the tenant-scope extension nulls a foreign row, which surfaces as a
    // domain exception the HTTP layer must see as 404.
    it('maps an unknown id to NotFoundException', async () => {
      mockConsultationRepository.findById.mockRejectedValue(new DataNotFoundException('consultation', CONSULTATION));

      await expect(service.getTelemetry(CONSULTATION)).rejects.toThrow(NotFoundException);
    });

    // RED: a `.catch(() => null)` would have turned an outage into a 404.
    it('lets a non-"not found" repository failure propagate rather than reporting 404', async () => {
      mockConsultationRepository.findById.mockRejectedValue(new Error('connection reset'));

      await expect(service.getTelemetry(CONSULTATION)).rejects.toThrow('connection reset');
    });

    // RED: the ledger read is the one that could scan another tenant's window.
    it('scopes the usage-ledger read to the caller tenant', async () => {
      await service.getTelemetry(CONSULTATION);

      expect(mockAiUsageEventRepository.findByConsultation).toHaveBeenCalledWith(TENANT, CONSULTATION);
    });
  });

  describe('audit', () => {
    // RED: a read of clinical telemetry left no trace.
    it('broadcasts ResourceViewed', async () => {
      await service.getTelemetry(CONSULTATION);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.objectContaining({ resourceId: CONSULTATION }));
    });
  });

  describe('without a settings service wired', () => {
    // RED: an optional dependency that is actually required crashes the pane.
    it('still answers, and never claims PRUNED', async () => {
      const bare = buildService(false);
      mockConsultationRepository.findById.mockResolvedValue({
        id: CONSULTATION,
        tenantId: TENANT,
        createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      });

      const result = await bare.getTelemetry(CONSULTATION);

      expect(result.partialSummary).toMatchObject({ available: false, reason: 'NO_ACTIVITY' });
    });
  });
});
