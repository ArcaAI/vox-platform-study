/**
 * TASK-1045 e2e (E2E-40) — a governed run that ends without a clinical result on a STOPPED
 * consultation stamps the run's terminal status on the governing marker.
 *
 * Live e2e 2026-10-06, consultation `01a10dde-…` (ArcaAI, `arcaai-bren-consultation`): the run
 * failed (`OUTPUT_INVALID`) after the note path failed, `failGovernedRun` marked processing FAILED
 * — and left the marker without `runStatus`. `governingRunOf` reads that as RUNNING, so the
 * clinician's "Generate case note now" (`POST :id/summary/async`) coalesced onto a run that had
 * already ended, and no note was ever generated. The marker is the system of record for the run's
 * outcome on every branch, not only the "still in progress" one.
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

const failedRun = { tenantId: TENANT, runId: RUN_ID, status: 'FAILED' as const, reason: 'NOTE_GENERATION_FAILED' };
const GOVERNED = { governingEngine: { engine: 'tenant-workflow', workflowRunId: RUN_ID, workflowDefinitionSlug: 'arcaai-bren-consultation' } };

function stampedMarker(updateWithVersion: ReturnType<typeof vi.fn>): Record<string, unknown> | undefined {
  const entity = updateWithVersion.mock.calls.at(-1)?.[1] as { metadata?: { governingEngine?: Record<string, unknown> } } | undefined;
  return entity?.metadata?.governingEngine;
}

describe('failGovernedRun on a STOPPED consultation records the run outcome on the marker (E2E-40)', () => {
  it('no note written: processing FAILED AND the marker reads FAILED (not RUNNING)', async () => {
    const consultation = consultationFixture({ status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.FAILED, metadata: GOVERNED });
    const { service, consultationRepository, lifecycleGate } = build(consultation);

    await service.failGovernedRun(CONSULTATION, failedRun);

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.FAILED, 'NOTE_GENERATION_FAILED');
    expect(stampedMarker(consultationRepository.updateWithVersion)).toEqual(
      expect.objectContaining({ workflowRunId: RUN_ID, runStatus: 'FAILED', terminalReason: 'NOTE_GENERATION_FAILED' }),
    );
  });

  it('note already written: processing untouched, the marker still reads FAILED', async () => {
    const consultation = consultationFixture({
      status: ConsultationStatus.STOPPED,
      processing: ConsultationProcessing.AWAITING_REVIEW,
      metadata: GOVERNED,
    });
    const { service, consultationRepository, lifecycleGate } = build(consultation);

    await service.failGovernedRun(CONSULTATION, failedRun);

    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
    expect(stampedMarker(consultationRepository.updateWithVersion)).toEqual(expect.objectContaining({ runStatus: 'FAILED' }));
  });

  it('an ungoverned consultation gains no marker', async () => {
    const consultation = consultationFixture({ status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.IDLE, metadata: null });
    const { service, consultationRepository } = build(consultation);

    await service.failGovernedRun(CONSULTATION, failedRun);

    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });
});
