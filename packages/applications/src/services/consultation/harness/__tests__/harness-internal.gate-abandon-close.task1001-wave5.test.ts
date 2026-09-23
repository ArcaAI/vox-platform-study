/**
 * TASK-1001 wave 5, owner decision D-6 (2026-09-23) — a TERMINAL harness gate abandon closes the
 * consultation.
 *
 * "Time out and close the consultation session after 5 min if there is no approval signal." The
 * five minutes is configuration (the harness gate SLA); what the gateway owns is the outcome of
 * the terminal `gate_sla_abandoned` escalation: the consultation lands in `CLOSED_INCOMPLETE`
 * (closed, unsigned). A late clinician sign-off still signs it (D-7, `CLOSED_INCOMPLETE → SIGNED`).
 *
 * What these specs pin:
 *   - PENDING_REVIEW keeps its TIMED_OUT leg (WORM `SESSION_TIMED_OUT` + clinician notification)
 *     and is THEN closed — one OCC write of the final state, both edges validated by the matrix.
 *   - DRAINING (a draft persisted without advancing the lifecycle), DRAFT_PENDING_SENSORS and an
 *     already-TIMED_OUT consultation close directly.
 *   - A consultation the clinician is RECORDING again is never closed, nor is one already signed,
 *     reopened or closed — each is a logged no-op SUCCESS, never the 409 this route used to answer
 *     (`Illegal consultation state transition: CLOSED_INCOMPLETE → TIMED_OUT`, seen live on a
 *     retried terminal escalation).
 *   - The non-terminal `gate_sla_breached` still writes no status.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsultationEntity, ConsultationStatus, HarnessAuditAction, ResourceStatusType, SysEventType } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CONSULTATION = '01a08a8d-651c-0000-0000-000000000001';

function consultationIn(status: ConsultationStatus): ConsultationEntity {
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
  );

  const wormActions = () => harnessAuditService.append.mock.calls.map((c: unknown[]) => (c[0] as { action: string }).action);
  return { service, consultationRepository, harnessAuditService, notificationService, eventEmitter, wormActions };
}

const abandon = { tenantId: TENANT, reason: 'gate_sla_abandoned', jobId: 'harness-doc-1' };
const breach = { tenantId: TENANT, reason: 'gate_sla_breached', jobId: 'harness-doc-1' };

describe('HarnessInternalService.recordEscalation — terminal gate abandon closes the consultation (TASK-1001 wave 5, D-6)', () => {
  it('PENDING_REVIEW: keeps the TIMED_OUT leg (WORM + notification), then closes CLOSED_INCOMPLETE in ONE OCC write', async () => {
    const consultation = consultationIn(ConsultationStatus.PENDING_REVIEW);
    const { service, consultationRepository, notificationService, wormActions } = build(consultation);

    const result = await service.recordEscalation(CONSULTATION, abandon as never);

    expect(result).toEqual({ recorded: true });
    expect(consultation.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);
    expect(consultation.lastTransition).toMatchObject({
      from: ConsultationStatus.TIMED_OUT,
      to: ConsultationStatus.CLOSED_INCOMPLETE,
      actor: 'system',
    });
    expect(consultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(consultationRepository.updateWithVersion).toHaveBeenCalledWith(CONSULTATION, consultation, 4);

    expect(wormActions()).toEqual([
      HarnessAuditAction.GATE_ABANDONED,
      HarnessAuditAction.SESSION_TIMED_OUT,
      HarnessAuditAction.SESSION_CLOSED_INCOMPLETE,
    ]);
    expect(notificationService.create).toHaveBeenCalledTimes(1);
    expect(notificationService.create).toHaveBeenCalledWith(expect.objectContaining({ targetUserId: 'doctor-1', tenantId: TENANT }));
  });

  it('broadcasts a ResourceUpdated sys-event naming the close, like failGovernedRun', async () => {
    const consultation = consultationIn(ConsultationStatus.PENDING_REVIEW);
    const { service, eventEmitter } = build(consultation);

    await service.recordEscalation(CONSULTATION, abandon as never);

    const payloads = eventEmitter.emit.mock.calls.filter((c: unknown[]) => c[0] === SysEventType.ResourceUpdated).map((c: unknown[]) => c[1]);
    expect(payloads).toEqual([
      expect.objectContaining({
        resourceId: CONSULTATION,
        data: expect.objectContaining({ action: 'recordEscalation', status: ConsultationStatus.CLOSED_INCOMPLETE, reason: 'gate_sla_abandoned' }),
      }),
    ]);
  });

  it('DRAINING (draft persisted without advancing the lifecycle): closes CLOSED_INCOMPLETE, no TIMED_OUT leg', async () => {
    const consultation = consultationIn(ConsultationStatus.DRAINING);
    const { service, consultationRepository, notificationService, wormActions } = build(consultation);

    await expect(service.recordEscalation(CONSULTATION, abandon as never)).resolves.toEqual({ recorded: true });

    expect(consultation.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);
    expect(consultationRepository.updateWithVersion).toHaveBeenCalledWith(CONSULTATION, consultation, 4);
    expect(wormActions()).toEqual([HarnessAuditAction.GATE_ABANDONED, HarnessAuditAction.SESSION_CLOSED_INCOMPLETE]);
    expect(notificationService.create).not.toHaveBeenCalled();
  });

  it.each([ConsultationStatus.TIMED_OUT, ConsultationStatus.DRAFT_PENDING_SENSORS])('%s: closes CLOSED_INCOMPLETE directly', async (status) => {
    const consultation = consultationIn(status);
    const { service, consultationRepository, wormActions } = build(consultation);

    await service.recordEscalation(CONSULTATION, abandon as never);

    expect(consultation.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);
    expect(consultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(wormActions()).toEqual([HarnessAuditAction.GATE_ABANDONED, HarnessAuditAction.SESSION_CLOSED_INCOMPLETE]);
  });

  it('RECORDING (the clinician resumed): the consultation is NOT closed — unchanged, no write, no throw', async () => {
    const consultation = consultationIn(ConsultationStatus.RECORDING);
    const { service, consultationRepository, wormActions } = build(consultation);

    await expect(service.recordEscalation(CONSULTATION, abandon as never)).resolves.toEqual({ recorded: true });

    expect(consultation.status).toBe(ConsultationStatus.RECORDING);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(wormActions()).toEqual([HarnessAuditAction.GATE_ABANDONED]);
  });

  it('CLOSED_INCOMPLETE (a retried terminal escalation): idempotent no-op success, never the old 409', async () => {
    const consultation = consultationIn(ConsultationStatus.CLOSED_INCOMPLETE);
    const { service, consultationRepository, notificationService } = build(consultation);

    await expect(service.recordEscalation(CONSULTATION, abandon as never)).resolves.toEqual({ recorded: true });

    expect(consultation.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(notificationService.create).not.toHaveBeenCalled();
  });

  it.each([ConsultationStatus.SIGNED, ConsultationStatus.CLOSED_COMPLETE, ConsultationStatus.REOPENED])(
    '%s (already past the gate): unchanged, no write, no throw',
    async (status) => {
      const consultation = consultationIn(status);
      const { service, consultationRepository } = build(consultation);

      await expect(service.recordEscalation(CONSULTATION, abandon as never)).resolves.toEqual({ recorded: true });

      expect(consultation.status).toBe(status);
      expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    },
  );

  it('a SESSION_CLOSED_INCOMPLETE WORM failure never rolls back the persisted close (best-effort)', async () => {
    const consultation = consultationIn(ConsultationStatus.DRAINING);
    const { service, consultationRepository, harnessAuditService } = build(consultation);
    harnessAuditService.append.mockImplementation(async (event: { action: string }) => {
      if (event.action === HarnessAuditAction.SESSION_CLOSED_INCOMPLETE) throw new Error('worm down');
      return { id: 'audit-1' };
    });

    await expect(service.recordEscalation(CONSULTATION, abandon as never)).resolves.toEqual({ recorded: true });
    expect(consultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(consultation.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);
  });

  it('non-terminal gate_sla_breached: writes no status, only the GATE_ESCALATED row (unchanged behaviour)', async () => {
    const consultation = consultationIn(ConsultationStatus.PENDING_REVIEW);
    const { service, consultationRepository, notificationService, wormActions } = build(consultation);

    await expect(service.recordEscalation(CONSULTATION, breach as never)).resolves.toEqual({ recorded: true });

    expect(consultation.status).toBe(ConsultationStatus.PENDING_REVIEW);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(notificationService.create).not.toHaveBeenCalled();
    expect(wormActions()).toEqual([HarnessAuditAction.GATE_ESCALATED]);
  });
});

// TASK-1001 wave 6 — the gateway's own completion-timeout job (engine-independent) closes through the
// same lifecycle writer, and leaves a consultation that is not waiting for approval alone.
describe('HarnessInternalService.closeOnCompletionTimeout (TASK-1001 wave 6)', () => {
  it('closes a PENDING_REVIEW consultation unsigned', async () => {
    const consultation = consultationIn(ConsultationStatus.PENDING_REVIEW);
    const { service, consultationRepository } = build(consultation);

    await service.closeOnCompletionTimeout(CONSULTATION, TENANT);

    expect(consultation.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);
    expect(consultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it.each([ConsultationStatus.RECORDING, ConsultationStatus.SIGNED, ConsultationStatus.CLOSED_COMPLETE, ConsultationStatus.CLOSED_INCOMPLETE])(
    'leaves a %s consultation alone',
    async (status) => {
      const consultation = consultationIn(status);
      const { service, consultationRepository } = build(consultation);

      await service.closeOnCompletionTimeout(CONSULTATION, TENANT);

      expect(consultation.status).toBe(status);
      expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    },
  );

  it('a consultation that no longer exists is a no-op, never a throw', async () => {
    const { service, consultationRepository } = build(consultationIn(ConsultationStatus.PENDING_REVIEW));
    consultationRepository.findById.mockResolvedValue(null);
    await expect(service.closeOnCompletionTimeout(CONSULTATION, TENANT)).resolves.toBeUndefined();
  });
});
