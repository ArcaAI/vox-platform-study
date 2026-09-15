/**
 * TASK-972 Lane 2, verification criterion V5 — the one property the opt-out must never break.
 *
 * > An opted-out clinician yields NO exemplar — and the sign-off still returns 200 and still
 * > closes.
 *
 * The opt-out suppresses CAPTURE ONLY. A clinical action is never failed, delayed or rolled back
 * for a training-data reason, so this spec drives `approveSummary` through the REAL
 * `GateEditMiningQueue` (not a double) with the gate switched off, and asserts the signature is
 * complete and the queue is untouched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SummaryService } from '../summary.service';
import { GateEditMiningQueue } from '../../../gate-edit-mining/gate-edit-mining.processor';
import { ConsultationEntity, ConsultationStatus } from '@arcaai/domains';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ContextItemVersionFactory: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      CreateSignedNoteVersion: vi.fn((props: any) => ({ ...props, id: 'signed-1', changeReason: 'approved', createdAt: new Date('2026-06-15T00:00:00.000Z') })),
    },
  };
});

const TENANT = 'tenant-1';
const CONSULTATION = 'c-1';
const CONTEXT_ITEM = 'ci-1';
const DOCTOR = 'doctor-1';

const cls = () => ({
  get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: DOCTOR, roles: [] } : null)),
  set: vi.fn(),
});

const makeMocks = () => ({
  contextItemRepository: {
    findById: vi.fn().mockResolvedValue({
      id: CONTEXT_ITEM,
      tenantId: TENANT,
      consultationId: CONSULTATION,
      isFinalSummary: true,
      content: 'SIGNED NOTE BODY',
      currentVersionNumber: 1,
      version: 1,
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
        doctorId: DOCTOR,
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
  contextItemVersionRepository: { create: vi.fn(async (e: unknown) => e), getVersionsByChangeReason: vi.fn().mockResolvedValue([]) },
  promptAssembly: { assemble: vi.fn() },
  harnessAudit: { append: vi.fn().mockResolvedValue({ id: 'a-1' }) },
});

type Mocks = ReturnType<typeof makeMocks>;

const build = (m: Mocks, miningQueue: unknown) => {
  const args: unknown[] = new Array(37).fill(undefined);
  args[0] = m.contextItemRepository;
  args[1] = m.consultationRepository;
  args[2] = m.summaryMetaRepository;
  args[3] = m.namedEntityRepository;
  args[4] = m.httpService;
  args[5] = m.configService;
  args[6] = m.eventEmitter;
  args[7] = cls();
  args[8] = m.contextItemVersionRepository;
  args[9] = m.promptAssembly;
  args[12] = m.harnessAudit;
  args[26] = miningQueue;
  return new SummaryService(...(args as ConstructorParameters<typeof SummaryService>));
};

describe('V5 — an opted-out clinician still signs, and yields no exemplar', () => {
  let m: Mocks;
  let bullQueue: { add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    m = makeMocks();
    bullQueue = { add: vi.fn().mockResolvedValue(undefined) };
  });

  const miningQueueWith = (effective: boolean) =>
    new GateEditMiningQueue(bullQueue as never, {
      resolveEffectiveTrainingCaptureEnabled: vi.fn(async () => ({ effective, tenantEnabled: true, doctorToggle: effective ? null : false })),
    } as never);

  it('signs normally and queues NOTHING when the clinician opted out', async () => {
    const service = build(m, miningQueueWith(false));

    const result = await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    // The clinical action completed in full…
    expect(result.approvalStatus).toBe('APPROVED');
    expect(m.harnessAudit.append).toHaveBeenCalled();
    expect(m.consultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    const persisted = m.consultationRepository.updateWithVersion.mock.calls[0][1] as { status: string };
    expect(persisted.status).toBe(ConsultationStatus.SIGNED);
    // …and nothing was captured.
    expect(bullQueue.add).not.toHaveBeenCalled();
  });

  it('queues the encounter, carrying the consultation`s clinician, when capture is enabled', async () => {
    const service = build(m, miningQueueWith(true));

    await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(bullQueue.add).toHaveBeenCalledTimes(1);
    expect(bullQueue.add.mock.calls[0][1]).toMatchObject({ tenantId: TENANT, consultationId: CONSULTATION, doctorId: DOCTOR });
  });
});
