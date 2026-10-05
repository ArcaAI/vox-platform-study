/**
 * TASK-1001 wave 5 (D-6 / D-7), re-pinned by TASK-1045 D-26 — a late clinician sign-off still signs.
 *
 * An auto-closed consultation is `CLOSED_INCOMPLETE` (closed, unsigned). A clinician who presses
 * Copy to EMR AFTER that must still sign the note: the clock never signs, a human still can. The
 * per-summary approve delegates to the session approve, which atomically reopens, approves and
 * closes → `CLOSED_COMPLETE`, writing the WORM `ATTEST` row and recording the late sign-off.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { SummaryService } from '../summary.service';
import { wireSessionApproval } from './session-approval.fixture';
import { ConsultationClosedReason, ConsultationEntity, ConsultationStatus, HarnessAuditAction } from '@arcaai/domains';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ContextItemVersionFactory: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      CreateSignedNoteVersion: vi.fn((props: any) => ({
        ...props,
        changedBy: props.attestedBy,
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
  const service = new SummaryService(...(args as ConstructorParameters<typeof SummaryService>));
  // approveSummary delegates to the session approve; wire the real one behind ModuleRef.
  wireSessionApproval(service);
  return service;
};

describe('SummaryService.approveSummary — a late sign-off after an incomplete close (TASK-1045 D-26)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs a note whose consultation is CLOSED_INCOMPLETE: reopened, approved and closed in one write → CLOSED_COMPLETE, WORM ATTEST written', async () => {
    const consultation = consultationIn(ConsultationStatus.CLOSED_INCOMPLETE);
    const m = makeMocks(consultation);
    const service = build(m);

    const result = await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(result.approvedBy).toBe(CLINICIAN);
    // ONE consultation write, against the version it was read at, carrying only the final state.
    expect(m.consultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    const [id, written, expected] = m.consultationRepository.updateWithVersion.mock.calls[0] as unknown as [string, ConsultationEntity, number];
    expect(id).toBe(CONSULTATION);
    expect(expected).toBe(7);
    expect(written.status).toBe(ConsultationStatus.CLOSED_COMPLETE);
    expect(written.closedReason).toBe(ConsultationClosedReason.APPROVED);
    expect(written.approvedAt).toBeInstanceOf(Date);
    expect(written.lastTransition).toMatchObject({
      from: ConsultationStatus.APPROVED,
      to: ConsultationStatus.CLOSED_COMPLETE,
      actor: CLINICIAN,
      reason: 'late_sign_off',
    });

    const actions = m.harnessAudit.append.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual([HarnessAuditAction.ATTEST, HarnessAuditAction.SESSION_APPROVED]);
    const attest = m.harnessAudit.append.mock.calls.find((c) => c[0].action === HarnessAuditAction.ATTEST)![0];
    expect(attest.clinicianId).toBe(CLINICIAN);
    // The session row records it as a late sign-off.
    const session = m.harnessAudit.append.mock.calls.find((c) => c[0].action === HarnessAuditAction.SESSION_APPROVED)![0];
    expect(session.sensorScores).toMatchObject({ lateSignOff: true, fromStatus: ConsultationStatus.CLOSED_INCOMPLETE });

    const updated = m.eventEmitter.emit.mock.calls.map((c) => c[1]).find((p) => p?.data?.approvalStatus === 'APPROVED');
    expect(updated.data.consultationStatus).toBe(ConsultationStatus.CLOSED_COMPLETE);
  });

  it('is an idempotent no-op on CLOSED_COMPLETE (D-29): a retried Copy to EMR never fails, nothing is re-signed', async () => {
    const consultation = consultationIn(ConsultationStatus.CLOSED_COMPLETE);
    const m = makeMocks(consultation);

    const result = await build(m).approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(result.approvalStatus).toBe('APPROVED');
    expect(m.consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(m.contextItemVersionRepository.create).not.toHaveBeenCalled();
    expect(m.harnessAudit.append).not.toHaveBeenCalled();
  });

  it('still refuses a state the matrix does not allow (OPEN → APPROVED is a 409)', async () => {
    const consultation = consultationIn(ConsultationStatus.OPEN);
    const m = makeMocks(consultation);

    await expect(build(m).approveSummary(CONTEXT_ITEM, { expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictException);
    expect(m.consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });
});
