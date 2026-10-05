/**
 * TASK-972 Lane 1 — `closeConsultation` carries the same named-clinician rule as the sign-off.
 *
 * The writes ALaaS makes on a clinician's submit are `update → approve → close`. A machine that can
 * sign but not close would leave the session one state short of terminal, so the rule has to reach
 * every one of them or it reaches none.
 *
 * TASK-1045: `ConsultationService.closeConsultation` is a deprecated alias that DELEGATES to
 * `IConsultationLifecycleService.close` (pinned in the first block). The named-clinician rule
 * therefore belongs to the lifecycle close, and the second block pins it there. Those cases are
 * `it.fails`: the lifecycle close attributes the close to `caller.userId ?? clinicianUserId`
 * without validating the named clinician and writes no WORM close row — a defect reported by the
 * AB-8a sweep. Each one fails on its OWN assertion today; when the rule is restored, vitest reports
 * the `it.fails` as failing and the marker must be removed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConsultationService } from '../consultation.service';
import { ConsultationLifecycleService } from '../../lifecycle/consultation-lifecycle.service';
import { ConsultationEntity, ConsultationStatus, HarnessAuditAction } from '@arcaai/domains';
import { encounterServiceDouble, lifecycleDouble, type LifecycleDouble } from './consultation-service.fixture';

const TENANT = 'tenant-1';
const CONSULTATION = 'c-1';
const CALLER = 'doctor-1';
const CLINICIAN = 'doctor-2';

const cls = (user: unknown, serviceAccount: unknown = null) => ({
  get: vi.fn((key: string) => {
    if (key === 'tenantId') return TENANT;
    if (key === 'user') return user;
    if (key === 'serviceAccount') return serviceAccount;
    return null;
  }),
  set: vi.fn(),
  run: vi.fn(async (fn: () => unknown) => fn()),
});

const consultationAt = (status: ConsultationStatus) =>
  new ConsultationEntity({
    id: CONSULTATION,
    tenantId: TENANT,
    patientId: 'patient-1',
    departmentId: null,
    doctorId: CLINICIAN,
    parentConsultationId: null,
    appointmentDate: new Date('2026-01-01'),
    metadata: null,
    degradedReasons: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    createdBy: 'user-1',
    status,
    version: 3,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

describe('ConsultationService.closeConsultation — delegates the attribution inputs to the lifecycle close', () => {
  let lifecycle: LifecycleDouble;
  const build = (user: unknown, serviceAccount: unknown = null) => {
    const consultationRepository = { findWithRelations: vi.fn() };
    lifecycle = lifecycleDouble();
    const args: unknown[] = new Array(9).fill(undefined);
    args[0] = consultationRepository;
    args[5] = { emit: vi.fn() };
    args[6] = cls(user, serviceAccount);
    args[7] = encounterServiceDouble(consultationRepository as never);
    args[8] = lifecycle;
    return new ConsultationService(...(args as ConstructorParameters<typeof ConsultationService>));
  };

  it('forwards the named clinician and a SERVICE-ACCOUNT caller in the lifecycle form', async () => {
    const service = build(null, { id: 'svc-1' });

    await service.closeConsultation(CONSULTATION, 3, {
      clinicianUserId: CLINICIAN,
      caller: { credentialClass: 'service-account', principalId: 'svc-1' },
    });

    expect(lifecycle.close).toHaveBeenCalledWith(CONSULTATION, {
      expectedVersion: 3,
      clinicianUserId: CLINICIAN,
      caller: { isMachine: true, serviceAccountId: 'svc-1' },
    });
  });

  it('forwards an API-key caller with its bound user, and a human caller as itself', async () => {
    const service = build({ id: CALLER, roles: [] });

    await service.closeConsultation(CONSULTATION, 3, { caller: { credentialClass: 'api-key', principalId: 'key-1', boundUserId: CALLER } });
    await service.closeConsultation(CONSULTATION, 4, { caller: { credentialClass: 'jwt', principalId: CALLER } });

    expect(lifecycle.close).toHaveBeenNthCalledWith(1, CONSULTATION, {
      expectedVersion: 3,
      caller: { isMachine: true, apiKeyId: 'key-1', userId: CALLER },
    });
    expect(lifecycle.close).toHaveBeenNthCalledWith(2, CONSULTATION, { expectedVersion: 4, caller: { isMachine: false, userId: CALLER } });
  });
});

describe('ConsultationLifecycleService.close — machine attribution (TASK-972 Lane 1)', () => {
  let consultations: { findByIdOrNull: ReturnType<typeof vi.fn>; updateWithVersion: ReturnType<typeof vi.fn> };
  let harnessAudit: { append: ReturnType<typeof vi.fn> };

  const build = (user: unknown, serviceAccount: unknown = null) =>
    new ConsultationLifecycleService(
      consultations as never,
      { endEncounter: vi.fn().mockResolvedValue(true) } as never, // encounterRepository
      {} as never, // contextItemRepository
      {} as never, // approvals
      {} as never, // gate
      { publish: vi.fn().mockResolvedValue(undefined) } as never, // events
      { emit: vi.fn() } as never,
      cls(user, serviceAccount) as never,
    );

  const persistedUpdatedBy = () => (consultations.updateWithVersion.mock.calls[0]?.[1] as ConsultationEntity | undefined)?.updatedBy;

  beforeEach(() => {
    vi.clearAllMocks();
    consultations = {
      findByIdOrNull: vi.fn(async () => consultationAt(ConsultationStatus.APPROVED)),
      updateWithVersion: vi.fn(async (_id: string, entity: ConsultationEntity) => entity),
    };
    harnessAudit = { append: vi.fn().mockResolvedValue({ id: 'a-1' }) };
  });

  it('closes as SELF for a human who names nobody — the pre-ticket path, unchanged', async () => {
    const service = build({ id: CALLER, roles: [] });

    const result = await service.close(CONSULTATION, { expectedVersion: 3 });

    expect(result.status).toBe(ConsultationStatus.CLOSED_COMPLETE);
    expect(persistedUpdatedBy()).toBe(CALLER);
  });

  it('short-circuits an already-terminal consultation without applying the rule', async () => {
    consultations.findByIdOrNull.mockResolvedValue(consultationAt(ConsultationStatus.CLOSED_COMPLETE));
    const service = build(null, { id: 'svc-1' });

    const result = await service.close(CONSULTATION, { expectedVersion: 3, caller: { isMachine: true, serviceAccountId: 'svc-1' } });

    expect(result.status).toBe(ConsultationStatus.CLOSED_COMPLETE);
    expect(consultations.updateWithVersion).not.toHaveBeenCalled();
  });

  // ── DEFECT (AB-8a): the named-clinician rule is not enforced by the lifecycle close ────────────

  it.fails('DEFECT — REFUSES a service-account close that names no clinician (400)', async () => {
    const service = build(null, { id: 'svc-1' });
    await expect(service.close(CONSULTATION, { expectedVersion: 3, caller: { isMachine: true, serviceAccountId: 'svc-1' } })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(consultations.updateWithVersion).not.toHaveBeenCalled();
  });

  it.fails('DEFECT — answers 404 for a named clinician outside the tenant (never 403)', async () => {
    const service = build(null, { id: 'svc-1' });
    await expect(
      service.close(CONSULTATION, { expectedVersion: 3, clinicianUserId: 'doctor-elsewhere', caller: { isMachine: true, serviceAccountId: 'svc-1' } }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.fails('DEFECT — REFUSES a clinician naming another clinician (400)', async () => {
    const service = build({ id: CALLER, roles: [] });
    await expect(
      service.close(CONSULTATION, { expectedVersion: 3, clinicianUserId: CLINICIAN, caller: { isMachine: false, userId: CALLER } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.fails('DEFECT — a machine close is attributed to the named clinician and writes the WORM close row naming the credential', async () => {
    const service = build(null, { id: 'svc-1' });

    const result = await service.close(CONSULTATION, {
      expectedVersion: 3,
      clinicianUserId: CLINICIAN,
      caller: { isMachine: true, serviceAccountId: 'svc-1' },
    });

    expect(result.status).toBe(ConsultationStatus.CLOSED_COMPLETE);
    expect(persistedUpdatedBy()).toBe(CLINICIAN);
    const worm = harnessAudit.append.mock.calls[0]?.[0];
    expect(worm).toMatchObject({ action: HarnessAuditAction.SESSION_CLOSED_COMPLETE, clinicianId: CLINICIAN, createdBy: 'svc-1' });
  });
});
