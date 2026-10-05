/**
 * TASK-1045 — a governed run that fails AFTER the note path already failed the consultation by
 * name keeps that reason.
 *
 * When the handoff cannot compose the note plan (`NOTE_INPUT_EXCEEDS_CONTEXT`,
 * `NOTE_MODEL_CONTEXT_UNDECLARED`) the gateway marks processing FAILED with that code and the
 * finalizer degrades with it. The run then ends FAILED for a downstream reason (a gate timeout, an
 * output-schema miss) that says nothing about why: `failGovernedRun` must not replace the specific
 * reason with it.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ContextItemType, ResourceStatusType } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CONSULTATION = '01a08a8d-651c-0000-0000-000000000001';
const RUN_ID = '01a08a8d-65fb-742b-824e-1c94af99e898';

function consultationFixture(overrides: Record<string, unknown>): ConsultationEntity {
  return new ConsultationEntity({
    id: CONSULTATION,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-09-10'),
    metadata: null,
    degradedReasons: [],
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-09-10'),
    updatedAt: new Date('2026-09-10'),
    createdBy: 'user-1',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    version: 4,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function build(consultation: ConsultationEntity | null, opts: { ownDrafts?: Array<Record<string, unknown>> } = {}) {
  // `failGovernedRun` asks whether the harness already wrote this consultation's note.
  const contextItemRepository = {
    findByType: vi.fn(async (_cid: string, type: ContextItemType) => (type === ContextItemType.RAW_SUMMARY ? (opts.ownDrafts ?? []) : [])),
  };
  // The processing axis moves through the lifecycle gate (no status write, no `_version` bump).
  const lifecycleGate = { setProcessing: vi.fn().mockResolvedValue(true) };
  const consultationRepository = {
    findById: vi.fn().mockResolvedValue(consultation),
    updateWithVersion: vi.fn().mockImplementation(async (_id: string, entity: unknown) => entity),
  };
  const store = new Map<string, unknown>();
  const cls = {
    run: vi.fn((...args: unknown[]) => (args.length === 1 ? (args[0] as () => unknown) : (args[1] as () => unknown))()),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
  const progressService = { reportProgress: vi.fn().mockResolvedValue({ ok: true }) };
  const eventEmitter = { emit: vi.fn() };

  const service = new HarnessInternalService(
    contextItemRepository as never,
    consultationRepository as never,
    undefined as never, // namedEntityRepository
    undefined as never, // summaryMetaRepository
    undefined as never, // promptAssemblyService
    undefined as never, // promptTemplateRepository
    undefined as never, // harnessAuditService
    cls as never,
    undefined, // jobService
    undefined, // highlightRepository
    undefined, // assuranceService
    undefined, // configResolver
    undefined, // contextItemVersionRepository
    undefined, // secretsService
    undefined, // redisCache
    undefined, // transcriptSegmentRepository
    undefined, // harnessPolicyService
    undefined, // mcpServerRepository
    undefined, // usageLedgerService
    undefined, // notificationService
    undefined, // providerConnectionService
    undefined, // visitTypes
    undefined, // aiModelRepository
    progressService as never,
    eventEmitter as never,
    undefined, // routingPolicies
    undefined, // effectiveSettings
    undefined, // dnaReportRepository
    lifecycleGate as never,
  );

  return { service, consultationRepository, progressService, eventEmitter, cls, lifecycleGate };
}

const failedRun = { tenantId: TENANT, runId: RUN_ID, status: 'FAILED' as const, reason: 'n_output schema failure' };

describe('HarnessInternalService.failGovernedRun keeps an existing FAILED reason (TASK-1045)', () => {
  it('a consultation already FAILED by name keeps its reason — the run reason does not overwrite it', async () => {
    const consultation = consultationFixture({
      status: ConsultationStatus.STOPPED,
      processing: ConsultationProcessing.FAILED,
      processingReason: 'NOTE_INPUT_EXCEEDS_CONTEXT',
    });
    const { service, lifecycleGate, progressService } = build(consultation);

    const result = await service.failGovernedRun(CONSULTATION, failedRun);

    expect(result).toEqual({ transitioned: true, status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.FAILED });
    for (const call of lifecycleGate.setProcessing.mock.calls) {
      expect(call).toEqual([CONSULTATION, ConsultationProcessing.FAILED, 'NOTE_INPUT_EXCEEDS_CONTEXT']);
    }
    expect(progressService.reportProgress).toHaveBeenCalledWith(CONSULTATION, expect.objectContaining({ label: 'NOTE_INPUT_EXCEEDS_CONTEXT' }));
  });

  it('a consultation not yet FAILED still takes the run reason', async () => {
    const consultation = consultationFixture({ status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.IDLE });
    const { service, lifecycleGate } = build(consultation);

    await service.failGovernedRun(CONSULTATION, failedRun);

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.FAILED, 'n_output schema failure');
  });

  it('a FAILED consultation with no recorded reason takes the run reason', async () => {
    const consultation = consultationFixture({
      status: ConsultationStatus.STOPPED,
      processing: ConsultationProcessing.FAILED,
      processingReason: null,
    });
    const { service, lifecycleGate } = build(consultation);

    await service.failGovernedRun(CONSULTATION, failedRun);

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.FAILED, 'n_output schema failure');
  });
});

describe('HarnessInternalService.reportProgress(failed) keeps an existing FAILED reason (TASK-1045)', () => {
  const failedProgress = { tenantId: TENANT, stage: 'failed', label: 'assemble refused' };

  it('a harness-doc run that fails after the note plan failed by name does not overwrite the reason', async () => {
    const consultation = consultationFixture({
      status: ConsultationStatus.STOPPED,
      processing: ConsultationProcessing.FAILED,
      processingReason: 'NOTE_INPUT_EXCEEDS_CONTEXT',
    });
    const { service, lifecycleGate } = build(consultation);

    await service.reportProgress(CONSULTATION, failedProgress as never);

    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
  });

  it('a STOPPED consultation with no note and no reason is failed with NOTE_GENERATION_FAILED', async () => {
    const consultation = consultationFixture({ status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.SUMMARIZING });
    const { service, lifecycleGate } = build(consultation);

    await service.reportProgress(CONSULTATION, failedProgress as never);

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.FAILED, 'NOTE_GENERATION_FAILED');
  });
});
