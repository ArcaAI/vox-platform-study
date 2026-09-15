/**
 * TASK-972 Lane 1, at the service level — the named clinician reaches the ATTESTATION, and the
 * credential is recorded beside them.
 *
 * `clinician-attribution.task972.test.ts` pins the RULE. These specs pin that `approveSummary`
 * and `updateSummary` actually apply it, and — the part that matters clinically — that what
 * lands on `approvedBy` / `attestedBy` / the `SIGNED_NOTE` version is the CLINICIAN, while the
 * machine appears only as the ACTOR on the WORM `ATTEST` row and the sys-event.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SummaryService } from '../summary.service';
import { ConsultationEntity, ConsultationStatus } from '@arcaai/domains';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ContextItemVersionFactory: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      CreateSignedNoteVersion: vi.fn((props: any) => ({ ...props, id: 'signed-1', changeReason: 'approved', createdAt: new Date('2026-06-15T00:00:00.000Z') })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      CreateFromContextItem: vi.fn((item: any, versionNumber: number, changeReason: string, changedBy: string) => ({
        id: 'v-1',
        contextItemId: item.id,
        versionNumber,
        changeReason,
        changedBy,
        content: item.content ?? null,
        createdAt: new Date('2026-06-15T00:00:00.000Z'),
      })),
    },
  };
});

const TENANT = 'tenant-1';
const CONSULTATION = 'c-1';
const CONTEXT_ITEM = 'ci-1';
const CALLER = 'doctor-1';
const CLINICIAN = 'doctor-2';

const cls = (user: unknown = { id: CALLER, roles: [] }, serviceAccount: unknown = null) => ({
  get: vi.fn((key: string) => {
    if (key === 'tenantId') return TENANT;
    if (key === 'user') return user;
    if (key === 'serviceAccount') return serviceAccount;
    return null;
  }),
  set: vi.fn(),
});

const makeMocks = () => ({
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
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      toObject: () => ({}),
      changes: {},
    }),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
    encryptContentIntoEntity: vi.fn(),
  },
  consultationRepository: {
    findById: vi.fn().mockResolvedValue(
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
        status: ConsultationStatus.PENDING_REVIEW,
        version: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ),
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
  // A full member of TENANT — role + department — so `assertUserBelongsToTenant` passes.
  userRoleAssignmentRepository: { findFirst: vi.fn().mockResolvedValue({ id: 'ra-1' }), findAll: vi.fn().mockResolvedValue([]) },
  userDepartmentRepository: { findFirst: vi.fn().mockResolvedValue({ id: 'ud-1' }) },
  userRepository: { findFirst: vi.fn().mockResolvedValue({ id: CLINICIAN }) },
});

type Mocks = ReturnType<typeof makeMocks>;

const build = (m: Mocks, opts: { user?: unknown; serviceAccount?: unknown } = {}) => {
  // `??` would swallow a deliberate `user: null` (the machine-caller case), so the default is
  // applied on ABSENCE of the key, not on a nullish value.
  const user = 'user' in opts ? opts.user : { id: CALLER, roles: [] };
  const args: unknown[] = new Array(37).fill(undefined);
  args[0] = m.contextItemRepository;
  args[1] = m.consultationRepository;
  args[2] = m.summaryMetaRepository;
  args[3] = m.namedEntityRepository;
  args[4] = m.httpService;
  args[5] = m.configService;
  args[6] = m.eventEmitter;
  args[7] = cls(user, opts.serviceAccount ?? null);
  args[8] = m.contextItemVersionRepository;
  args[9] = m.promptAssembly;
  args[12] = m.harnessAudit;
  args[32] = m.userRoleAssignmentRepository;
  args[33] = m.userDepartmentRepository;
  args[34] = m.userRepository;
  return new SummaryService(...(args as ConstructorParameters<typeof SummaryService>));
};

describe('SummaryService.approveSummary — machine sign-off attribution (TASK-972 Lane 1)', () => {
  let m: Mocks;

  beforeEach(() => {
    vi.clearAllMocks();
    m = makeMocks();
  });

  it('REFUSES a service-account sign-off that names no clinician (400)', async () => {
    const service = build(m, { user: null, serviceAccount: { id: 'svc-1' } });
    await expect(service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 })).rejects.toBeInstanceOf(BadRequestException);
    expect(m.harnessAudit.append).not.toHaveBeenCalled();
  });

  it('records the NAMED CLINICIAN as the attesting clinician, not the machine', async () => {
    const service = build(m, { user: null, serviceAccount: { id: 'svc-1' } });

    const result = await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1, clinicianUserId: CLINICIAN });

    expect(result.approvedBy).toBe(CLINICIAN);
    const attest = m.harnessAudit.append.mock.calls.find((c) => c[0].action === 'ATTEST')![0];
    expect(attest.clinicianId).toBe(CLINICIAN);
    // …and the CREDENTIAL is recorded beside them, never instead of them.
    // `createdBy` is WHO SUBMITTED the row; `clinicianId` is WHO ATTESTED it.
    expect(attest.createdBy).toBe('svc-1');
  });

  it('stamps the SIGNED_NOTE version with the clinician (`attestedBy`)', async () => {
    const service = build(m, { user: null, serviceAccount: { id: 'svc-1' } });

    await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1, clinicianUserId: CLINICIAN });

    const created = m.contextItemVersionRepository.create.mock.calls[0][0] as { attestedBy: string };
    expect(created.attestedBy).toBe(CLINICIAN);
  });

  it('names the credential on the sys-event while the clinician stays the responsible entity', async () => {
    const service = build(m, { user: null, serviceAccount: { id: 'svc-1' } });

    await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1, clinicianUserId: CLINICIAN });

    const updated = m.eventEmitter.emit.mock.calls.map((c) => c[1]).find((p) => p?.data?.approvalStatus === 'APPROVED');
    expect(updated.responsibleEntityId).toBe(CLINICIAN);
    expect(updated.data.actorPrincipalId).toBe('svc-1');
  });

  it('answers 404 for a clinician outside the tenant (never 403)', async () => {
    m.userRoleAssignmentRepository.findFirst.mockResolvedValue(null);
    const service = build(m, { user: null, serviceAccount: { id: 'svc-1' } });

    await expect(service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1, clinicianUserId: CLINICIAN })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('REFUSES a clinician naming another clinician (400)', async () => {
    const service = build(m);
    await expect(service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1, clinicianUserId: CLINICIAN })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('signs as SELF for a human who names nobody — the pre-ticket path, unchanged', async () => {
    const service = build(m);
    const result = await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });
    expect(result.approvedBy).toBe(CALLER);
  });
});

describe('SummaryService.updateSummary — machine edit attribution (TASK-972 Lane 1)', () => {
  let m: Mocks;

  beforeEach(() => {
    vi.clearAllMocks();
    m = makeMocks();
  });

  it('REFUSES a machine edit that names no clinician (400)', async () => {
    const service = build(m, { user: null, serviceAccount: { id: 'svc-1' } });
    await expect(service.updateSummary(CONTEXT_ITEM, { content: 'edited', expectedVersion: 1 } as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('attributes the MODIFIED_SUMMARY version to the named clinician', async () => {
    const service = build(m, { user: null, serviceAccount: { id: 'svc-1' } });

    await service.updateSummary(CONTEXT_ITEM, { content: 'edited', expectedVersion: 1, clinicianUserId: CLINICIAN } as never);

    const created = m.contextItemVersionRepository.create.mock.calls[0][0] as { changedBy: string };
    expect(created.changedBy).toBe(CLINICIAN);
  });
});
