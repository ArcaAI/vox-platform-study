/**
 * TASK-972 Lane 1 — `closeConsultation` carries the same named-clinician rule as the sign-off.
 *
 * The three writes ALaaS must make on a clinician's submit are `update → approve → close`, in
 * that order (`PENDING_REVIEW → CLOSED_*` is not a legal edge). A machine that can sign but not
 * close would leave the session parked one state short of terminal, so the rule has to reach all
 * three or it reaches none of them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConsultationService } from '../consultation.service';
import { ConsultationEntity, ConsultationStatus } from '@arcaai/domains';

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

const signedConsultation = () => consultationAt(ConsultationStatus.SIGNED);

const makeMocks = () => ({
  consultationRepository: {
    findWithRelations: vi.fn().mockResolvedValue(signedConsultation()),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
  },
  departmentRepository: {},
  userRoleAssignmentRepository: { findFirst: vi.fn().mockResolvedValue({ id: 'ra-1' }), findAll: vi.fn().mockResolvedValue([]) },
  userDepartmentRepository: { findFirst: vi.fn().mockResolvedValue({ id: 'ud-1' }) },
  userRepository: { findFirst: vi.fn().mockResolvedValue({ id: CLINICIAN }) },
  eventEmitter: { emit: vi.fn() },
  harnessAudit: { append: vi.fn().mockResolvedValue({ id: 'a-1' }) },
});

type Mocks = ReturnType<typeof makeMocks>;

const build = (m: Mocks, opts: { user?: unknown; serviceAccount?: unknown } = {}) => {
  const user = 'user' in opts ? opts.user : { id: CALLER, roles: [] };
  const args: unknown[] = new Array(20).fill(undefined);
  args[0] = m.consultationRepository;
  args[1] = m.departmentRepository;
  args[2] = m.userRoleAssignmentRepository;
  args[3] = m.userDepartmentRepository;
  args[4] = m.userRepository;
  args[5] = m.eventEmitter;
  args[6] = cls(user, opts.serviceAccount ?? null);
  args[8] = m.harnessAudit;
  return new ConsultationService(...(args as ConstructorParameters<typeof ConsultationService>));
};

describe('ConsultationService.closeConsultation — machine attribution (TASK-972 Lane 1)', () => {
  let m: Mocks;

  beforeEach(() => {
    vi.clearAllMocks();
    m = makeMocks();
  });

  it('REFUSES a service-account close that names no clinician (400)', async () => {
    const service = build(m, { user: null, serviceAccount: { id: 'svc-1' } });
    await expect(service.closeConsultation(CONSULTATION, 3)).rejects.toBeInstanceOf(BadRequestException);
    expect(m.consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('closes a SIGNED consultation as CLOSED_COMPLETE, attributed to the named clinician', async () => {
    const service = build(m, { user: null, serviceAccount: { id: 'svc-1' } });

    const result = await service.closeConsultation(CONSULTATION, 3, { clinicianUserId: CLINICIAN });

    expect(result.status).toBe(ConsultationStatus.CLOSED_COMPLETE);
    const persisted = m.consultationRepository.updateWithVersion.mock.calls[0][1] as { updatedBy: string };
    expect(persisted.updatedBy).toBe(CLINICIAN);
    // The WORM row names the clinician, and the CREDENTIAL beside them.
    const worm = m.harnessAudit.append.mock.calls[0][0];
    expect(worm.clinicianId).toBe(CLINICIAN);
    expect(worm.createdBy).toBe('svc-1');
  });

  it('answers 404 for a clinician outside the tenant (never 403)', async () => {
    m.userRoleAssignmentRepository.findFirst.mockResolvedValue(null);
    const service = build(m, { user: null, serviceAccount: { id: 'svc-1' } });
    await expect(service.closeConsultation(CONSULTATION, 3, { clinicianUserId: CLINICIAN })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('REFUSES a clinician naming another clinician (400)', async () => {
    const service = build(m);
    await expect(service.closeConsultation(CONSULTATION, 3, { clinicianUserId: CLINICIAN })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('closes as SELF for a human who names nobody — the pre-ticket path, unchanged', async () => {
    const service = build(m);
    const result = await service.closeConsultation(CONSULTATION, 3);
    expect(result.status).toBe(ConsultationStatus.CLOSED_COMPLETE);
    const persisted = m.consultationRepository.updateWithVersion.mock.calls[0][1] as { updatedBy: string };
    expect(persisted.updatedBy).toBe(CALLER);
  });

  it('short-circuits an already-terminal consultation without applying the rule', async () => {
    m.consultationRepository.findWithRelations.mockResolvedValue(consultationAt(ConsultationStatus.CLOSED_COMPLETE));
    const service = build(m, { user: null, serviceAccount: { id: 'svc-1' } });

    const result = await service.closeConsultation(CONSULTATION, 3);

    expect(result.status).toBe(ConsultationStatus.CLOSED_COMPLETE);
    expect(m.consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });
});
