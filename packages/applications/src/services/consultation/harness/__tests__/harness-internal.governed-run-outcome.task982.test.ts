/**
 * A governed run that fails BEFORE the consultation reaches `DRAINING`.
 *
 * ## The gap
 *
 * `failGovernedRun` acts only on `DRAINING`, which is the state a consultation reaches when the
 * clinician has stopped recording. A trigger that refuses its payload fails the run on its FIRST
 * node — seconds after `open`, while the consultation is still `OPEN` — and nothing on any
 * surface said so: no status change (correctly: the clinician can still record and the default
 * loop can still document), but also no event, no marker, and nothing on the SSE feed the client
 * is already holding open.
 *
 * ## What changes, and what deliberately does not
 *
 * For `OPEN` / `RECORDING` / `PRIMED` the run's outcome is RECORDED and ANNOUNCED — the marker
 * gains `runStatus: 'FAILED'` with its reason, the sys-event fires, and one `workflow.failed`
 * frame goes out on the live-summary channel the client is already subscribed to. The
 * consultation's own `status` is untouched: a failed governing run is not a failed consultation
 * (owner decision), and the clinician keeps working.
 *
 * `DRAINING` keeps its existing behaviour exactly — `CLOSED_INCOMPLETE`, because there the
 * clinician has finished and there is nothing left to write the note.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationEntity, ConsultationStatus, ResourceStatusType, SysEventType } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CONSULTATION = '01a08a8d-651c-0000-0000-000000000001';
const RUN_ID = '01a08a8d-65fb-742b-824e-1c94af99e898';
const SLUG = 'arcaai-consultation-v1';

const GOVERNED_METADATA = {
  governingEngine: { engine: 'tenant-workflow', workflowRunId: RUN_ID, workflowDefinitionSlug: SLUG, decidedAt: '2026-09-17T09:00:00.000Z' },
};

function consultationFixture(overrides: Record<string, unknown>): ConsultationEntity {
  return new ConsultationEntity({
    id: CONSULTATION,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-09-17'),
    metadata: GOVERNED_METADATA,
    degradedReasons: [],
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-09-17'),
    updatedAt: new Date('2026-09-17'),
    createdBy: 'user-1',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    version: 4,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function build(consultation: ConsultationEntity) {
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
  const published: { channel: string; message: string }[] = [];
  const redisCache = { publish: vi.fn(async (channel: string, message: string) => void published.push({ channel, message })) };

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
    redisCache as never,
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

  return { service, consultationRepository, progressService, eventEmitter, published };
}

const failedRun = { tenantId: TENANT, runId: RUN_ID, status: 'FAILED' as const, reason: 'core.trigger refused the run payload' };

function markerOf(consultation: ConsultationEntity): Record<string, unknown> {
  return (consultation.metadata as Record<string, Record<string, unknown>>).governingEngine;
}

describe.each([ConsultationStatus.OPEN, ConsultationStatus.RECORDING, ConsultationStatus.PRIMED])(
  'a governed run that fails while the consultation is %s',
  (status) => {
    let consultation: ConsultationEntity;
    beforeEach(() => {
      consultation = consultationFixture({ status });
    });

    it('leaves the consultation status untouched — a failed run is not a failed consultation', async () => {
      const { service, consultationRepository } = build(consultation);

      const result = await service.failGovernedRun(CONSULTATION, failedRun);

      expect(result.transitioned).toBe(false);
      expect(result.status).toBe(status);
      expect(consultation.status).toBe(status);
      expect(consultationRepository.updateWithVersion).toHaveBeenCalledWith(CONSULTATION, consultation, 4);
    });

    it('stamps the outcome on the governing-engine marker, where every read surface looks', async () => {
      const { service } = build(consultation);

      await service.failGovernedRun(CONSULTATION, failedRun);

      expect(markerOf(consultation)).toMatchObject({
        engine: 'tenant-workflow',
        workflowRunId: RUN_ID,
        workflowDefinitionSlug: SLUG,
        runStatus: 'FAILED',
        terminalReason: 'core.trigger refused the run payload',
      });
      expect(markerOf(consultation).endedAt).toEqual(expect.any(String));
    });

    it('broadcasts the sys-event', async () => {
      const { service, eventEmitter } = build(consultation);

      await service.failGovernedRun(CONSULTATION, failedRun);

      expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: CONSULTATION }));
    });

    it('publishes ONE workflow.failed frame on the live-summary channel the client already holds', async () => {
      const { service, published } = build(consultation);

      await service.failGovernedRun(CONSULTATION, failedRun);

      expect(published).toHaveLength(1);
      expect(published[0].channel).toBe(`consultation:live-summary:${CONSULTATION}`);
      expect(JSON.parse(published[0].message)).toEqual({
        event: 'workflow.failed',
        consultationId: CONSULTATION,
        workflowRunId: RUN_ID,
        workflowDefinitionSlug: SLUG,
        reason: 'core.trigger refused the run payload',
      });
    });

    it('still records the outcome when the SSE publish fails — the marker is the system of record', async () => {
      const { service, published } = build(consultation);
      // A Redis hiccup must never roll back the already-persisted outcome.
      const svc = service as unknown as { redisCache: { publish: ReturnType<typeof vi.fn> } };
      svc.redisCache.publish = vi.fn().mockRejectedValue(new Error('redis down'));

      await service.failGovernedRun(CONSULTATION, failedRun);

      expect(published).toHaveLength(0);
      expect(markerOf(consultation).runStatus).toBe('FAILED');
    });
  },
);

describe('the outcome is recorded only for a consultation a run can still be governing', () => {
  it('leaves a SIGNED consultation entirely alone — it has already moved past this run', async () => {
    const consultation = consultationFixture({ status: ConsultationStatus.SIGNED });
    const { service, consultationRepository, published, eventEmitter } = build(consultation);

    const result = await service.failGovernedRun(CONSULTATION, failedRun);

    expect(result.transitioned).toBe(false);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('records nothing extra on a consultation with no governing marker — there is no run to describe', async () => {
    const consultation = consultationFixture({ status: ConsultationStatus.OPEN, metadata: null });
    const { service, published } = build(consultation);

    await service.failGovernedRun(CONSULTATION, failedRun);

    expect(published).toHaveLength(0);
  });
});

describe('recordGovernedRunCompleted — the COMPLETED half of the same marker', () => {
  it('stamps COMPLETED with the degraded flag and the end time, leaving status alone', async () => {
    const consultation = consultationFixture({ status: ConsultationStatus.DRAFT_PENDING_SENSORS });
    const { service, consultationRepository } = build(consultation);

    await service.recordGovernedRunCompleted(CONSULTATION, {
      tenantId: TENANT,
      runId: RUN_ID,
      degraded: true,
      at: new Date('2026-09-17T09:30:00.000Z'),
    });

    expect(markerOf(consultation)).toMatchObject({ runStatus: 'COMPLETED', degraded: true, endedAt: '2026-09-17T09:30:00.000Z' });
    expect(consultation.status).toBe(ConsultationStatus.DRAFT_PENDING_SENSORS);
    expect(consultationRepository.updateWithVersion).toHaveBeenCalled();
  });

  it('omits the degraded flag when the run had no degraded or skipped node', async () => {
    const consultation = consultationFixture({ status: ConsultationStatus.DRAFT_PENDING_SENSORS });
    const { service } = build(consultation);

    await service.recordGovernedRunCompleted(CONSULTATION, { tenantId: TENANT, runId: RUN_ID, degraded: false });

    expect(markerOf(consultation)).toMatchObject({ runStatus: 'COMPLETED' });
    expect(markerOf(consultation)).not.toHaveProperty('degraded');
  });

  it('writes nothing when the marker names a DIFFERENT run — a stale watcher never overwrites the live one', async () => {
    const consultation = consultationFixture({ status: ConsultationStatus.DRAFT_PENDING_SENSORS });
    const { service, consultationRepository } = build(consultation);

    await service.recordGovernedRunCompleted(CONSULTATION, { tenantId: TENANT, runId: 'some-other-run', degraded: false });

    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('never throws when the consultation cannot be read — the run row is already recorded', async () => {
    const consultation = consultationFixture({ status: ConsultationStatus.DRAFT_PENDING_SENSORS });
    const { service, consultationRepository } = build(consultation);
    consultationRepository.findById.mockRejectedValue(new Error('database unavailable'));

    await expect(service.recordGovernedRunCompleted(CONSULTATION, { tenantId: TENANT, runId: RUN_ID, degraded: false })).resolves.toBeUndefined();
  });
});
