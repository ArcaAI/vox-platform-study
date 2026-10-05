/**
 * TASK-946 OD-4, re-pinned by TASK-1045 — a governed consultation whose run ended FAILED/TIMED_OUT
 * stops looking like it is still being documented.
 *
 * Measured 2026-09-10: every consultation stopped that day (16 of them) still looked in flight
 * eight hours after its interpreter workflow had closed FAILED. Since TASK-1045 the harness never
 * writes `status`: a STOPPED consultation whose note was never written is marked processing
 * `FAILED` with the run's reason, and stays open — the clinician can record again or close it, and
 * the auto-close sweep owns the idle case.
 *
 * A STOPPED consultation that already HOLDS the note (`AWAITING_REVIEW`, or `IDLE` with the harness
 * draft) is left alone: marking it failed because a later node of the same run failed would
 * misdescribe a written note.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ContextItemType, ResourceStatusType, SysEventType } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';
import { HARNESS_PROGRESS_FAILED_STAGE } from '../dto';
import { HARNESS_DRAFT_SUBTYPE } from '../harness-draft.constants';

const TENANT = '50000000-0000-0000-0000-000000000001';
const OTHER_TENANT = '50000000-0000-0000-0000-0000000000ff';
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

describe('HarnessInternalService.failGovernedRun (TASK-946 OD-4, TASK-1045 processing axis)', () => {
  let consultation: ConsultationEntity;
  beforeEach(() => {
    // Stopped, transcript final, no note written yet — the run was the thing writing it.
    consultation = consultationFixture({ status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.IDLE });
  });

  it('ignores the failure of a SUPERSEDED run — the marker names a newer governing run (TASK-1022 resume)', async () => {
    const superseded = consultationFixture({
      status: ConsultationStatus.STOPPED,
      processing: ConsultationProcessing.IDLE,
      metadata: { governingEngine: { engine: 'tenant-workflow', workflowRunId: 'run-new', workflowDefinitionSlug: 'wf', supersededRunId: RUN_ID } },
    });
    const { service, consultationRepository, lifecycleGate } = build(superseded);

    const result = await service.failGovernedRun(CONSULTATION, failedRun);

    expect(result).toEqual({ transitioned: false, status: ConsultationStatus.STOPPED });
    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('marks a STOPPED consultation with no written note processing FAILED with the run reason — status untouched', async () => {
    const { service, consultationRepository, lifecycleGate } = build(consultation);

    const result = await service.failGovernedRun(CONSULTATION, failedRun);

    expect(result).toEqual({ transitioned: true, status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.FAILED });
    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.FAILED, 'n_output schema failure');
    expect(consultation.status).toBe(ConsultationStatus.STOPPED);
    // No status write and no `_version` bump: the gate's writer is the only write.
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('publishes a harness-progress FAILED event so the caller stops seeing heartbeats', async () => {
    const { service, progressService } = build(consultation);

    await service.failGovernedRun(CONSULTATION, failedRun);

    expect(progressService.reportProgress).toHaveBeenCalledWith(
      CONSULTATION,
      expect.objectContaining({ tenantId: TENANT, stage: HARNESS_PROGRESS_FAILED_STAGE, label: 'n_output schema failure' }),
    );
  });

  it('broadcasts the consultation ResourceUpdated sys-event', async () => {
    const { service, eventEmitter } = build(consultation);

    await service.failGovernedRun(CONSULTATION, failedRun);

    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    const [type, event] = eventEmitter.emit.mock.calls[0]!;
    expect(type).toBe(SysEventType.ResourceUpdated);
    expect(event.resourceId).toBe(CONSULTATION);
    expect(event.data).toMatchObject({
      action: 'failGovernedRun',
      status: ConsultationStatus.STOPPED,
      processing: ConsultationProcessing.FAILED,
      runId: RUN_ID,
    });
  });

  it('marks on a TIMED_OUT run as well — the named outcome stands in for a missing reason', async () => {
    const { service, lifecycleGate } = build(consultation);

    const result = await service.failGovernedRun(CONSULTATION, { tenantId: TENANT, runId: RUN_ID, status: 'TIMED_OUT' });

    expect(result.processing).toBe(ConsultationProcessing.FAILED);
    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.FAILED, 'GOVERNED_RUN_TIMED_OUT');
  });

  it.each([
    ['a note awaiting review', { status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.AWAITING_REVIEW }, []],
    ['a written harness draft', { status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.IDLE }, [{ id: 'd-1', metaData: { subType: HARNESS_DRAFT_SUBTYPE } }]],
    ['an approved consultation', { status: ConsultationStatus.APPROVED, processing: ConsultationProcessing.IDLE }, []],
  ])('leaves %s untouched — never misdescribes a written or signed note', async (_label, state, ownDrafts) => {
    const written = consultationFixture(state);
    const { service, consultationRepository, progressService, eventEmitter, lifecycleGate } = build(written, { ownDrafts });

    const result = await service.failGovernedRun(CONSULTATION, failedRun);

    expect(result).toEqual({ transitioned: false, status: state.status });
    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(progressService.reportProgress).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('is a no-op on a closed consultation', async () => {
    const closed = consultationFixture({ status: ConsultationStatus.CLOSED_INCOMPLETE });
    const { service, lifecycleGate } = build(closed);

    const result = await service.failGovernedRun(CONSULTATION, failedRun);

    expect(result.transitioned).toBe(false);
    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
  });

  it('a cross-tenant consultation id is a 404, never a 403', async () => {
    const foreign = consultationFixture({ status: ConsultationStatus.STOPPED, tenantId: OTHER_TENANT });
    const { service, lifecycleGate } = build(foreign);

    await expect(service.failGovernedRun(CONSULTATION, failedRun)).rejects.toBeInstanceOf(NotFoundException);
    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
  });

  it('an unknown consultation id is a 404', async () => {
    const { service } = build(null);

    await expect(service.failGovernedRun(CONSULTATION, failedRun)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a soft-deleted consultation is a 404 (the writable guard every other callback applies)', async () => {
    const deleted = consultationFixture({ status: ConsultationStatus.STOPPED, resourceStatus: ResourceStatusType.DELETED });
    const { service } = build(deleted);

    await expect(service.failGovernedRun(CONSULTATION, failedRun)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a failing progress publish never rolls back the persisted outcome', async () => {
    const { service, progressService, lifecycleGate } = build(consultation);
    progressService.reportProgress.mockRejectedValue(new Error('redis down'));

    const result = await service.failGovernedRun(CONSULTATION, failedRun);

    expect(result.transitioned).toBe(true);
    expect(lifecycleGate.setProcessing).toHaveBeenCalled();
  });

  it('leaves the consultation metadata (the governing marker) as it was — the reason lives on processingReason', async () => {
    const withMarker = consultationFixture({
      status: ConsultationStatus.STOPPED,
      processing: ConsultationProcessing.IDLE,
      metadata: { governingEngine: { workflowRunId: RUN_ID, workflowDefinitionSlug: 'arcaai-consultation-v1' } },
    });
    const { service, lifecycleGate } = build(withMarker);

    await service.failGovernedRun(CONSULTATION, failedRun);

    expect(withMarker.metadata).toEqual({ governingEngine: { workflowRunId: RUN_ID, workflowDefinitionSlug: 'arcaai-consultation-v1' } });
    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.FAILED, 'n_output schema failure');
  });
});
