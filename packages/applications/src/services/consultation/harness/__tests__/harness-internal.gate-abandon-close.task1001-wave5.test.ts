/**
 * TASK-1001 wave 5 (D-6), re-pinned by TASK-1045 — what a harness review-gate escalation does to
 * the consultation.
 *
 * Until TASK-1045 the TERMINAL `gate_sla_abandoned` escalation closed the consultation
 * `CLOSED_INCOMPLETE` (via a `TIMED_OUT` leg), and the gateway's completion-timeout job closed it
 * the same way. Both closes are gone: the harness never writes `status`, the auto-close sweep
 * (`consultation.autoClose`) owns closing, and the completion-timeout processor only drains.
 *
 * What these specs pin now:
 *   - an escalation (terminal or not) flags a STOPPED consultation's processing `AWAITING_REVIEW`
 *     (the gate queue reads exactly that) through the lifecycle gate — no status write, no
 *     `_version` bump, the consultation stays open for approval;
 *   - the terminal abandon additionally notifies the clinician (best-effort);
 *   - a consultation the clinician is RECORDING again, or one already approved or closed, is left
 *     alone — a logged no-op SUCCESS, never a 409, so a retried escalation is harmless;
 *   - the WORM trail is the escalation row alone (`GATE_ABANDONED` / `GATE_ESCALATED`).
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, HarnessAuditAction, ResourceStatusType } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CONSULTATION = '01a08a8d-651c-0000-0000-000000000001';

function consultationIn(status: ConsultationStatus, processing: ConsultationProcessing = ConsultationProcessing.IDLE): ConsultationEntity {
  return new ConsultationEntity({
    id: CONSULTATION,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-09-23'),
    metadata: null,
    degradedReasons: [],
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-09-23'),
    updatedAt: new Date('2026-09-23'),
    createdBy: 'user-1',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    status,
    processing,
    version: 4,
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
  const harnessAuditService = { append: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
  const notificationService = { create: vi.fn().mockResolvedValue({ id: 'n-1' }) };
  const eventEmitter = { emit: vi.fn() };
  const lifecycleGate = { setProcessing: vi.fn().mockResolvedValue(true) };

  const service = new HarnessInternalService(
    undefined as never, // contextItemRepository
    consultationRepository as never,
    undefined as never, // namedEntityRepository
    undefined as never, // summaryMetaRepository
    undefined as never, // promptAssemblyService
    undefined as never, // promptTemplateRepository
    harnessAuditService as never,
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
    notificationService as never,
    undefined, // providerConnectionService
    undefined, // visitTypes
    undefined, // aiModelRepository
    undefined, // progressService
    eventEmitter as never,
    undefined, // routingPolicies
    undefined, // effectiveSettings
    undefined, // dnaReportRepository
    lifecycleGate as never,
  );

  const wormActions = () => harnessAuditService.append.mock.calls.map((c: unknown[]) => (c[0] as { action: string }).action);
  return { service, consultationRepository, harnessAuditService, notificationService, eventEmitter, lifecycleGate, wormActions };
}

const abandon = { tenantId: TENANT, reason: 'gate_sla_abandoned', jobId: 'harness-doc-1' };
const breach = { tenantId: TENANT, reason: 'gate_sla_breached', jobId: 'harness-doc-1' };

describe('HarnessInternalService.recordEscalation — a gate escalation flags the note for review, never closes (TASK-1045)', () => {
  it('terminal abandon on a STOPPED consultation: AWAITING_REVIEW through the gate, clinician notified, no status write', async () => {
    const consultation = consultationIn(ConsultationStatus.STOPPED);
    const { service, consultationRepository, notificationService, lifecycleGate, wormActions } = build(consultation);

    const result = await service.recordEscalation(CONSULTATION, abandon as never);

    expect(result).toEqual({ recorded: true });
    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.AWAITING_REVIEW, 'gate_sla_abandoned');
    expect(consultation.status).toBe(ConsultationStatus.STOPPED);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();

    expect(wormActions()).toEqual([HarnessAuditAction.GATE_ABANDONED]);
    expect(notificationService.create).toHaveBeenCalledTimes(1);
    expect(notificationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserId: 'doctor-1', tenantId: TENANT, data: { consultationId: CONSULTATION, action: 'GATE_ABANDONED' } }),
    );
  });

  it.each([ConsultationProcessing.SUMMARIZING, ConsultationProcessing.AWAITING_REVIEW])(
    'a STOPPED consultation whose processing is %s is flagged the same way (a retried escalation is harmless)',
    async (processing) => {
      const consultation = consultationIn(ConsultationStatus.STOPPED, processing);
      const { service, lifecycleGate } = build(consultation);

      await expect(service.recordEscalation(CONSULTATION, abandon as never)).resolves.toEqual({ recorded: true });

      expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.AWAITING_REVIEW, 'gate_sla_abandoned');
    },
  );

  it('a STOPPED consultation still finalizing its transcript is not flagged — that processing belongs to the stop flow', async () => {
    const consultation = consultationIn(ConsultationStatus.STOPPED, ConsultationProcessing.FINALIZING_TRANSCRIPT);
    const { service, lifecycleGate, notificationService } = build(consultation);

    await expect(service.recordEscalation(CONSULTATION, abandon as never)).resolves.toEqual({ recorded: true });

    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
    expect(notificationService.create).not.toHaveBeenCalled();
  });

  it('RECORDING (the clinician resumed): left alone — no flag, no write, no throw', async () => {
    const consultation = consultationIn(ConsultationStatus.RECORDING);
    const { service, consultationRepository, lifecycleGate, wormActions } = build(consultation);

    await expect(service.recordEscalation(CONSULTATION, abandon as never)).resolves.toEqual({ recorded: true });

    expect(consultation.status).toBe(ConsultationStatus.RECORDING);
    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(wormActions()).toEqual([HarnessAuditAction.GATE_ABANDONED]);
  });

  it.each([ConsultationStatus.APPROVED, ConsultationStatus.CLOSED_COMPLETE, ConsultationStatus.CLOSED_INCOMPLETE])(
    '%s (already past the gate): unchanged, no write, no throw — never the old 409',
    async (status) => {
      const consultation = consultationIn(status);
      const { service, consultationRepository, lifecycleGate, notificationService } = build(consultation);

      await expect(service.recordEscalation(CONSULTATION, abandon as never)).resolves.toEqual({ recorded: true });

      expect(consultation.status).toBe(status);
      expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
      expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
      expect(notificationService.create).not.toHaveBeenCalled();
    },
  );

  it('a clinician-notification failure never rolls back the escalation (best-effort)', async () => {
    const consultation = consultationIn(ConsultationStatus.STOPPED);
    const { service, notificationService, lifecycleGate, wormActions } = build(consultation);
    notificationService.create.mockRejectedValue(new Error('notifications down'));

    await expect(service.recordEscalation(CONSULTATION, abandon as never)).resolves.toEqual({ recorded: true });
    expect(lifecycleGate.setProcessing).toHaveBeenCalledTimes(1);
    expect(wormActions()).toEqual([HarnessAuditAction.GATE_ABANDONED]);
  });

  it('non-terminal gate_sla_breached: flags AWAITING_REVIEW, writes no status, only the GATE_ESCALATED row, no notification', async () => {
    const consultation = consultationIn(ConsultationStatus.STOPPED);
    const { service, consultationRepository, notificationService, lifecycleGate, wormActions } = build(consultation);

    await expect(service.recordEscalation(CONSULTATION, breach as never)).resolves.toEqual({ recorded: true });

    expect(consultation.status).toBe(ConsultationStatus.STOPPED);
    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.AWAITING_REVIEW, 'gate_sla_breached');
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(notificationService.create).not.toHaveBeenCalled();
    expect(wormActions()).toEqual([HarnessAuditAction.GATE_ESCALATED]);
  });
});
