/**
 * TASK-946 OD-4 — a governed consultation whose run ended FAILED/TIMED_OUT reaches a terminal
 * state instead of sitting in `DRAINING` until the 24h sweep.
 *
 * Measured 2026-09-10: every consultation stopped that day (16 of them) was still `DRAINING`
 * eight hours after its interpreter workflow had closed FAILED. `CLOSED_INCOMPLETE` is the
 * honest state — a clinician cannot sign a note that was never written — and `reopen` exists.
 *
 * The guard is deliberately an EXPLICIT `DRAINING` check rather than the broader
 * `canTransitionTo(CLOSED_INCOMPLETE)`: `DRAFT_PENDING_SENSORS` also legally reaches it, but a
 * consultation in that state HAS a draft, and closing it incomplete would discard a written note
 * because a later stage of the same run failed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConsultationEntity, ConsultationStatus, ResourceStatusType, SysEventType } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';
import { HARNESS_PROGRESS_FAILED_STAGE } from '../dto';

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

function build(consultation: ConsultationEntity | null) {
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
    undefined as never, // contextItemRepository
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
  );

  return { service, consultationRepository, progressService, eventEmitter, cls };
}

const failedRun = { tenantId: TENANT, runId: RUN_ID, status: 'FAILED' as const, reason: 'n_output schema failure' };

describe('HarnessInternalService.failGovernedRun (TASK-946 OD-4)', () => {
  let consultation: ConsultationEntity;
  beforeEach(() => {
    consultation = consultationFixture({ status: ConsultationStatus.DRAINING });
  });

  it('closes a DRAINING consultation as CLOSED_INCOMPLETE and stamps the terminal reason', async () => {
    const { service, consultationRepository } = build(consultation);

    const result = await service.failGovernedRun(CONSULTATION, failedRun);

    expect(result.transitioned).toBe(true);
    expect(result.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);
    expect(consultation.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);
    expect(consultationRepository.updateWithVersion).toHaveBeenCalledWith(CONSULTATION, consultation, 4);
    expect(consultation.metadata).toMatchObject({
      terminalReason: { runId: RUN_ID, status: 'FAILED', reason: 'n_output schema failure' },
    });
    expect((consultation.metadata as { terminalReason: { at: string } }).terminalReason.at).toEqual(expect.any(String));
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
    expect(event.data).toMatchObject({ action: 'failGovernedRun', status: ConsultationStatus.CLOSED_INCOMPLETE, runId: RUN_ID });
  });

  it('closes on TIMED_OUT as well', async () => {
    const { service } = build(consultation);

    const result = await service.failGovernedRun(CONSULTATION, { ...failedRun, status: 'TIMED_OUT' });

    expect(result.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);
  });

  it('leaves a consultation already past DRAINING untouched — never regresses a review or a signature', async () => {
    const pending = consultationFixture({ status: ConsultationStatus.PENDING_REVIEW });
    const { service, consultationRepository, progressService, eventEmitter } = build(pending);

    const result = await service.failGovernedRun(CONSULTATION, failedRun);

    expect(result.transitioned).toBe(false);
    expect(result.status).toBe(ConsultationStatus.PENDING_REVIEW);
    expect(pending.status).toBe(ConsultationStatus.PENDING_REVIEW);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(progressService.reportProgress).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('is idempotent — a retry after the flip is a no-op', async () => {
    const closed = consultationFixture({ status: ConsultationStatus.CLOSED_INCOMPLETE });
    const { service, consultationRepository } = build(closed);

    const result = await service.failGovernedRun(CONSULTATION, failedRun);

    expect(result.transitioned).toBe(false);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('a cross-tenant consultation id is a 404, never a 403', async () => {
    const foreign = consultationFixture({ status: ConsultationStatus.DRAINING, tenantId: OTHER_TENANT });
    const { service, consultationRepository } = build(foreign);

    await expect(service.failGovernedRun(CONSULTATION, failedRun)).rejects.toBeInstanceOf(NotFoundException);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('an unknown consultation id is a 404', async () => {
    const { service } = build(null);

    await expect(service.failGovernedRun(CONSULTATION, failedRun)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a soft-deleted consultation is a 404 (the writable guard every other callback applies)', async () => {
    const deleted = consultationFixture({ status: ConsultationStatus.DRAINING, resourceStatus: ResourceStatusType.DELETED });
    const { service } = build(deleted);

    await expect(service.failGovernedRun(CONSULTATION, failedRun)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a failing progress publish never rolls back the persisted transition', async () => {
    const { service, progressService, consultationRepository } = build(consultation);
    progressService.reportProgress.mockRejectedValue(new Error('redis down'));

    const result = await service.failGovernedRun(CONSULTATION, failedRun);

    expect(result.transitioned).toBe(true);
    expect(consultationRepository.updateWithVersion).toHaveBeenCalled();
  });

  it('preserves existing consultation metadata alongside the terminal reason', async () => {
    const withMarker = consultationFixture({
      status: ConsultationStatus.DRAINING,
      metadata: { governingEngine: { workflowRunId: RUN_ID, workflowDefinitionSlug: 'arcaai-consultation-v1' } },
    });
    const { service } = build(withMarker);

    await service.failGovernedRun(CONSULTATION, failedRun);

    expect(withMarker.metadata).toMatchObject({
      governingEngine: { workflowRunId: RUN_ID },
      terminalReason: { runId: RUN_ID },
    });
  });
});
