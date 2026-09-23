/**
 * TASK-1001 wave 5, owner decisions D-6 / D-7 (2026-09-23) — a late clinician sign-off still signs.
 *
 * A terminal harness gate abandon now closes the consultation `CLOSED_INCOMPLETE` (closed,
 * unsigned). A clinician who presses Save AFTER that must still sign the note: the clock never
 * signs, a human still can — the same rule `TIMED_OUT → SIGNED` already encodes. So
 * `approveSummary` accepts `CLOSED_INCOMPLETE` as a predecessor of `SIGNED` exactly as it accepts
 * `TIMED_OUT`, with the WORM `ATTEST` row written as usual.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { SummaryService } from '../summary.service';
import { ConsultationEntity, ConsultationStatus, HarnessAuditAction } from '@arcaai/domains';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ContextItemVersionFactory: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      CreateSignedNoteVersion: vi.fn((props: any) => ({
        ...props,
        id: 'signed-1',
        changeReason: 'approved',
        createdAt: new Date('2026-09-23T00:00:00.000Z'),
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      CreateFromContextItem: vi.fn((item: any, versionNumber: number, changeReason: string, changedBy: string) => ({
        id: 'v-1',
        contextItemId: item.id,
        versionNumber,
        changeReason,
        changedBy,
        content: item.content ?? null,
        createdAt: new Date('2026-09-23T00:00:00.000Z'),
      })),
    },
  };
});

const TENANT = 'tenant-1';
const CONSULTATION = 'c-1';
const CONTEXT_ITEM = 'ci-1';
const CLINICIAN = 'doctor-1';

const consultationIn = (status: ConsultationStatus) =>
  new ConsultationEntity({
    id: CONSULTATION,
    tenantId: TENANT,
    patientId: 'patient-1',
    departmentId: null,
    doctorId: CLINICIAN,
    parentConsultationId: null,
    appointmentDate: new Date('2026-09-23'),
    metadata: null,
    degradedReasons: [],
    createdAt: new Date('2026-09-23'),
    updatedAt: new Date('2026-09-23'),
    createdBy: 'user-1',
    status,
    version: 7,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

const makeMocks = (consultation: ConsultationEntity) => ({
  contextItemRepository: {
    findById: vi.fn().mockResolvedValue({
      id: CONTEXT_ITEM,
      tenantId: TENANT,
      consultationId: CONSULTATION,
      isFinalSummary: true,
      isSummary: true,
      content: 'SIGNED NOTE BODY',
      currentVersionNumber: 1,
      version: 1,
      createdAt: new Date('2026-09-23'),
      updatedAt: new Date('2026-09-23'),
      toObject: () => ({}),
      changes: {},
    }),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
    encryptContentIntoEntity: vi.fn(),
  },
  consultationRepository: {
    findById: vi.fn().mockResolvedValue(consultation),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
  },
  summaryMetaRepository: { findByContextItem: vi.fn().mockResolvedValue(null) },
  namedEntityRepository: { create: vi.fn() },
  httpService: { axiosRef: { post: vi.fn() } },
  configService: { get: vi.fn(() => undefined) },
  eventEmitter: { emit: vi.fn() },
  contextItemVersionRepository: {
    create: vi.fn(async (e: unknown) => e),
    getVersionsByChangeReason: vi.fn().mockResolvedValue([]),
    encryptFieldsIntoEntity: vi.fn(),
  },
  promptAssembly: { assemble: vi.fn() },
  harnessAudit: { append: vi.fn().mockResolvedValue({ id: 'a-1' }) },
  userRoleAssignmentRepository: { findFirst: vi.fn().mockResolvedValue({ id: 'ra-1' }), findAll: vi.fn().mockResolvedValue([]) },
  userDepartmentRepository: { findFirst: vi.fn().mockResolvedValue({ id: 'ud-1' }) },
  userRepository: { findFirst: vi.fn().mockResolvedValue({ id: CLINICIAN }) },
});

type Mocks = ReturnType<typeof makeMocks>;

const build = (m: Mocks) => {
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'tenantId') return TENANT;
      if (key === 'user') return { id: CLINICIAN, roles: [] };
      return null;
    }),
    set: vi.fn(),
  };
  const args: unknown[] = new Array(37).fill(undefined);
  args[0] = m.contextItemRepository;
  args[1] = m.consultationRepository;
  args[2] = m.summaryMetaRepository;
  args[3] = m.namedEntityRepository;
  args[4] = m.httpService;
  args[5] = m.configService;
  args[6] = m.eventEmitter;
  args[7] = cls;
  args[8] = m.contextItemVersionRepository;
  args[9] = m.promptAssembly;
  args[12] = m.harnessAudit;
  args[32] = m.userRoleAssignmentRepository;
  args[33] = m.userDepartmentRepository;
  args[34] = m.userRepository;
  return new SummaryService(...(args as ConstructorParameters<typeof SummaryService>));
};

describe('SummaryService.approveSummary — a late sign-off after a gate-abandon close (TASK-1001 wave 5, D-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs a note whose consultation is CLOSED_INCOMPLETE: → SIGNED, persisted, WORM ATTEST written', async () => {
    const consultation = consultationIn(ConsultationStatus.CLOSED_INCOMPLETE);
    const m = makeMocks(consultation);
    const service = build(m);

    const result = await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(result.approvedBy).toBe(CLINICIAN);
    expect(consultation.status).toBe(ConsultationStatus.SIGNED);
    expect(consultation.lastTransition).toMatchObject({
      from: ConsultationStatus.CLOSED_INCOMPLETE,
      to: ConsultationStatus.SIGNED,
      actor: CLINICIAN,
      reason: 'approveSummary',
    });
    // The consultation CAS runs against the version it was read at.
    expect(m.consultationRepository.updateWithVersion).toHaveBeenCalledWith(CONSULTATION, consultation, 7);

    const actions = m.harnessAudit.append.mock.calls.map((c) => c[0].action);
    expect(actions).toContain(HarnessAuditAction.ATTEST);
    const attest = m.harnessAudit.append.mock.calls.find((c) => c[0].action === HarnessAuditAction.ATTEST)![0];
    expect(attest.clinicianId).toBe(CLINICIAN);

    const updated = m.eventEmitter.emit.mock.calls.map((c) => c[1]).find((p) => p?.data?.approvalStatus === 'APPROVED');
    expect(updated.data.consultationStatus).toBe(ConsultationStatus.SIGNED);
  });

  it('is the same path TIMED_OUT already takes (the pre-existing late-sign precedent)', async () => {
    const consultation = consultationIn(ConsultationStatus.TIMED_OUT);
    const m = makeMocks(consultation);

    await build(m).approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(consultation.status).toBe(ConsultationStatus.SIGNED);
  });

  it('still refuses a predecessor the matrix does not allow (CLOSED_COMPLETE → SIGNED is a 409)', async () => {
    const consultation = consultationIn(ConsultationStatus.CLOSED_COMPLETE);
    const m = makeMocks(consultation);

    await expect(build(m).approveSummary(CONTEXT_ITEM, { expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictException);
    expect(m.consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });
});
