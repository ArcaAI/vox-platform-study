/**
 * TASK-1045 lane AB-4c — the harness callbacks drive the consultation's PROCESSING axis, never its
 * status.
 *
 *  - `persistDraft`: an EARLY draft (assurance pending) → SUMMARIZING; a final note → IDLE. No
 *    status write, no `_version` bump on the consultation.
 *  - `finalizeAssurance`: SUMMARIZING → IDLE.
 *  - `failGovernedRun`: a STOPPED consultation with no written note → FAILED with the run's reason.
 *  - `recordEscalation`: a gate escalation → AWAITING_REVIEW; the terminal abandon no longer closes.
 *  - `ConsultationEventHandler`: a resumed-session read failure is a hard failure
 *    (`PipelineStepFailed` + FAILED `RESUME_READ_FAILED`), never the first-session path.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConsultationEntity,
  ConsultationProcessing,
  ConsultationStatus,
  ContextItemType,
  HarnessAuditAction,
  ResourceStatusType,
} from '@arcaai/domains';

import { HarnessInternalService } from '../harness-internal.service';
import { HARNESS_DRAFT_PHASE } from '../dto';
import { ConsultationEventHandler } from '../../events/consultation-event.handler';
import { ConsultationPipelineEvent } from '../../events/consultation.events';
import { NOTE_READY_REASON } from '../../lifecycle/legacy-status-projection';

const TENANT = '50000000-0000-0000-0000-000000000045';
const CID = '01a08a8d-651c-0000-0000-000000001045';
const RUN_ID = 'run-1045';

const createMockCls = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((...args: unknown[]) => ((args.length === 1 ? args[0] : args[1]) as () => unknown)()),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
};

function consultation(overrides: Record<string, unknown>): ConsultationEntity {
  return new ConsultationEntity({
    id: CID,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-10-05'),
    metadata: null,
    degradedReasons: [],
    status: ConsultationStatus.STOPPED,
    processing: ConsultationProcessing.IDLE,
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-10-05'),
    updatedAt: new Date('2026-10-05'),
    createdBy: 'user-1',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    version: 7,
    ...overrides,
  } as never);
}

interface Wiring {
  consultation: ConsultationEntity;
  ownDrafts?: Array<Record<string, unknown>>;
}

function build(wiring: Wiring) {
  const contextItemRepository = {
    findTranscripts: vi.fn().mockResolvedValue([]),
    findByType: vi.fn(async (_cid: string, type: ContextItemType) => (type === ContextItemType.RAW_SUMMARY ? (wiring.ownDrafts ?? []) : [])),
    findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null, plaintext: null })),
    findById: vi.fn(async (id: string) => ({ id, content: 'note' })),
    create: vi.fn(async (entity: Record<string, unknown>) => ({ ...entity, id: 'ctx-new' })),
    update: vi.fn(),
    updateWithVersion: vi.fn(async (id: string, entity: Record<string, unknown>) => ({ ...entity, id })),
    encryptContentIntoEntity: vi.fn(),
  };
  const consultationRepository = {
    findById: vi.fn(async () => wiring.consultation),
    update: vi.fn(),
    updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
  };
  const summaryMetaRepository = {
    findByContextItem: vi.fn(async () => ({ id: 'sm-1', version: 1, citationsMap: null })),
    updateWithVersion: vi.fn(async () => ({ id: 'sm-1' })),
    encryptFieldsIntoEntity: vi.fn(),
    create: vi.fn(async () => ({ id: 'sm-new' })),
  };
  const harnessAuditService = { append: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
  const notificationService = { create: vi.fn().mockResolvedValue({ id: 'n-1' }) };
  const progressService = { reportProgress: vi.fn().mockResolvedValue({ ok: true }) };
  const eventEmitter = { emit: vi.fn() };
  const lifecycleGate = {
    assertContentWritable: vi.fn(),
    touchActivity: vi.fn(),
    beginProcessing: vi.fn(),
    endProcessing: vi.fn(),
    setProcessing: vi.fn().mockResolvedValue(undefined),
    currentEncounterSeq: vi.fn().mockResolvedValue(1),
  };

  const positional: unknown[] = [
    contextItemRepository, // 1
    consultationRepository, // 2
    { findByConsultation: vi.fn().mockResolvedValue([]), findByContextItem: vi.fn().mockResolvedValue([]) }, // 3 namedEntityRepository
    summaryMetaRepository, // 4
    { assemble: vi.fn() }, // 5 promptAssemblyService
    { findById: vi.fn() }, // 6 promptTemplateRepository
    harnessAuditService, // 7
    createMockCls(), // 8 cls
    undefined, // 9 jobService
    undefined, // 10 highlightRepository
    undefined, // 11 assuranceService
    undefined, // 12 configResolver
    undefined, // 13 contextItemVersionRepository
    undefined, // 14 secretsService
    undefined, // 15 redisCache
    undefined, // 16 transcriptSegmentRepository
    undefined, // 17 harnessPolicyService
    undefined, // 18 mcpServerRepository
    undefined, // 19 usageLedgerService
    notificationService, // 20
    undefined, // 21 providerConnectionService
    undefined, // 22 visitTypes
    undefined, // 23 aiModelRepository
    progressService, // 24
    eventEmitter, // 25
    undefined, // 26 routingPolicies
    undefined, // 27 effectiveSettings
    undefined, // 28 dnaReportRepository
    lifecycleGate, // 29
  ];
  const service = new (HarnessInternalService as unknown as new (...args: unknown[]) => HarnessInternalService)(...positional);
  return { service, consultationRepository, lifecycleGate, harnessAuditService, notificationService, progressService, eventEmitter };
}

const draft = (phase?: string) =>
  ({
    tenantId: TENANT,
    userId: 'harness',
    content: 'Assessment: viral URTI.',
    modelName: 'm',
    modelVersion: 'v',
    ...(phase ? { phase } : {}),
  }) as never;

describe('TASK-1045 AB-4c — persistDraft drives processing, never status', () => {
  it('an EARLY draft on a STOPPED consultation sets processing SUMMARIZING and writes no status', async () => {
    const row = consultation({});
    const { service, consultationRepository, lifecycleGate } = build({ consultation: row });

    await service.persistDraft(CID, draft(HARNESS_DRAFT_PHASE.EARLY));

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.SUMMARIZING);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(row.status).toBe(ConsultationStatus.STOPPED);
  });

  it('a final note sets processing IDLE and writes no status', async () => {
    const row = consultation({ processing: ConsultationProcessing.SUMMARIZING });
    const { service, consultationRepository, lifecycleGate } = build({ consultation: row });

    await service.persistDraft(CID, draft());

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.IDLE, NOTE_READY_REASON);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(row.status).toBe(ConsultationStatus.STOPPED);
  });

  it('a draft on an OPEN consultation (batch path) keeps the note and touches neither axis', async () => {
    const row = consultation({ status: ConsultationStatus.OPEN });
    const { service, consultationRepository, lifecycleGate } = build({ consultation: row });

    const result = await service.persistDraft(CID, draft());

    expect(result.contextItemId).toBe('ctx-new');
    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('never overrides a processing state another writer owns (transcript still finalizing)', async () => {
    const row = consultation({ processing: ConsultationProcessing.FINALIZING_TRANSCRIPT });
    const { service, lifecycleGate } = build({ consultation: row });

    await service.persistDraft(CID, draft());

    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
  });

  it('finalizeAssurance moves SUMMARIZING to IDLE without a status write', async () => {
    const row = consultation({ processing: ConsultationProcessing.SUMMARIZING });
    const { service, consultationRepository, lifecycleGate } = build({ consultation: row });

    await service.finalizeAssurance(CID, { tenantId: TENANT, contextItemId: 'ctx-draft', gateDecision: 'PASS' } as never);

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.IDLE, NOTE_READY_REASON);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });
});

describe('TASK-1045 AB-4c — failGovernedRun sets processing FAILED', () => {
  const failedRun = { tenantId: TENANT, runId: RUN_ID, status: 'FAILED' as const, reason: 'n_output schema failure' };

  it('a STOPPED consultation with no written note goes FAILED with the run reason; status stays STOPPED', async () => {
    const row = consultation({});
    const { service, consultationRepository, lifecycleGate, progressService } = build({ consultation: row });

    const result = await service.failGovernedRun(CID, failedRun);

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.FAILED, 'n_output schema failure');
    expect(result).toEqual({ transitioned: true, status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.FAILED });
    expect(row.status).toBe(ConsultationStatus.STOPPED);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(progressService.reportProgress).toHaveBeenCalledWith(CID, expect.objectContaining({ stage: 'failed' }));
  });

  it('a timed-out run with no reason names the outcome', async () => {
    const { service, lifecycleGate } = build({ consultation: consultation({ processing: ConsultationProcessing.SUMMARIZING }) });

    await service.failGovernedRun(CID, { tenantId: TENANT, runId: RUN_ID, status: 'TIMED_OUT' });

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.FAILED, 'GOVERNED_RUN_TIMED_OUT');
  });

  it('leaves a STOPPED consultation whose note is already written alone', async () => {
    const { service, lifecycleGate } = build({
      consultation: consultation({ processing: ConsultationProcessing.IDLE }),
      ownDrafts: [{ id: 'ctx-draft', metaData: { subType: 'HARNESS_DRAFT' }, createdAt: new Date() }],
    });

    const result = await service.failGovernedRun(CID, failedRun);

    expect(result.transitioned).toBe(false);
    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
  });

  it('never closes: an APPROVED consultation is left untouched', async () => {
    const row = consultation({ status: ConsultationStatus.APPROVED });
    const { service, lifecycleGate, consultationRepository } = build({ consultation: row });

    const result = await service.failGovernedRun(CID, failedRun);

    expect(result).toEqual({ transitioned: false, status: ConsultationStatus.APPROVED });
    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });
});

describe('TASK-1045 AB-4c — a gate escalation no longer closes the consultation', () => {
  it('the terminal abandon sets AWAITING_REVIEW, keeps the status and still records GATE_ABANDONED', async () => {
    const row = consultation({});
    const { service, consultationRepository, lifecycleGate, harnessAuditService } = build({ consultation: row });

    await service.recordEscalation(CID, { tenantId: TENANT, reason: 'gate_sla_abandoned', jobId: 'job-1' } as never);

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.AWAITING_REVIEW, 'gate_sla_abandoned');
    expect(row.status).toBe(ConsultationStatus.STOPPED);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    const actions = harnessAuditService.append.mock.calls.map((call) => (call[0] as { action: string }).action);
    expect(actions).toContain(HarnessAuditAction.GATE_ABANDONED);
    expect(actions).not.toContain(HarnessAuditAction.SESSION_CLOSED_INCOMPLETE);
  });

  it('a non-terminal escalation also flags AWAITING_REVIEW', async () => {
    const { service, lifecycleGate } = build({ consultation: consultation({}) });

    await service.recordEscalation(CID, { tenantId: TENANT, reason: 'gate_sla_breached' } as never);

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.AWAITING_REVIEW, 'gate_sla_breached');
  });

  it('an escalation on a consultation that is recording again changes nothing', async () => {
    const { service, lifecycleGate } = build({ consultation: consultation({ status: ConsultationStatus.RECORDING }) });

    await service.recordEscalation(CID, { tenantId: TENANT, reason: 'gate_sla_abandoned' } as never);

    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
  });
});

describe('TASK-1045 AB-4c — ConsultationEventHandler resume read failure is a hard failure', () => {
  function buildHandler(findTranscripts: ReturnType<typeof vi.fn>, status = ConsultationStatus.STOPPED) {
    const consultationRepository = { findById: vi.fn(async () => consultation({ status })) };
    const eventEmitter = { emit: vi.fn() };
    const noteGenerationService = {
      resolveConfig: vi.fn(async () => ({ autoSummaryEnabled: true })),
      generate: vi.fn(async () => ({ generator: 'harness' })),
    };
    const contextItemRepository = {
      findTranscripts,
      findByType: vi.fn(async () => [{ id: 'ctx-draft', metaData: { subType: 'HARNESS_DRAFT' }, createdAt: new Date() }]),
      findById: vi.fn(async () => ({ id: 'tx-2', content: 'later' })),
    };
    const lifecycleGate = { setProcessing: vi.fn().mockResolvedValue(undefined) };
    const handler = new (ConsultationEventHandler as unknown as new (...args: unknown[]) => ConsultationEventHandler)(
      consultationRepository,
      eventEmitter,
      createMockCls(),
      noteGenerationService,
      contextItemRepository,
      undefined, // configResolver
      undefined, // dnaReportRepository
      undefined, // secretsService
      { getVersionsByChangeReason: vi.fn(async () => []) }, // contextItemVersionRepository
      undefined, // workflowDispatch
      lifecycleGate,
    );
    return { handler, eventEmitter, noteGenerationService, lifecycleGate };
  }

  const payload = { consultationId: CID, tenantId: TENANT, contextItemId: 'tx-2', userId: 'user-1' } as never;

  it('emits PipelineStepFailed, sets FAILED RESUME_READ_FAILED and generates nothing', async () => {
    const { handler, eventEmitter, noteGenerationService, lifecycleGate } = buildHandler(vi.fn().mockRejectedValue(new Error('db down')));

    await handler.handleTranscriptionCreated(payload);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      ConsultationPipelineEvent.PipelineStepFailed,
      expect.objectContaining({ consultationId: CID, failedStep: 'summary', willContinue: false }),
    );
    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.FAILED, 'RESUME_READ_FAILED');
    expect(noteGenerationService.generate).not.toHaveBeenCalled();
  });

  it('treats an APPROVED consultation as signed — the resumed transcript is not re-finalised', async () => {
    const aggregates = [
      { id: 'tx-1', content: 'first', metaData: { subType: 'STT_AGGREGATE' }, createdAt: new Date('2026-10-05T09:00:00Z') },
      { id: 'tx-2', content: 'later', metaData: { subType: 'STT_AGGREGATE' }, createdAt: new Date('2026-10-05T10:00:00Z') },
    ];
    const { handler, noteGenerationService } = buildHandler(vi.fn().mockResolvedValue(aggregates), ConsultationStatus.APPROVED);

    await handler.handleTranscriptionCreated(payload);

    expect(noteGenerationService.generate).not.toHaveBeenCalled();
  });
});
