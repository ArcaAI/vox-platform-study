/**
 * TASK-792 W1 — `approveSummary` is the live writer of the gate-edit corpus.
 *
 * Before this ticket `GateEditExemplar` had NO live writer: `enqueue()` had zero
 * call sites anywhere in the repo. The capture substrate was already correct —
 * the immutable `ai_draft_v1` snapshot and the signed note both exist by the time
 * this method returns — but nothing consumed them.
 *
 * Three properties are asserted, and the last two matter more than the first:
 *
 *  1. a sign-off enqueues the encounter, with the ids the miner needs;
 *  2. an enqueue FAILURE never fails the sign-off (R6: the signature is the
 *     clinical system-of-record; a learning-loop outage must be invisible to it);
 *  3. an UNWIRED queue is equally harmless — the pre-ticket behaviour exactly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SummaryService } from '../summary.service';
import { ConsultationEntity, ConsultationStatus } from '@arcaai/domains';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ContextItemVersionFactory: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      CreateSignedNoteVersion: vi.fn((props: any) => ({
        id: 'signed-1',
        contextItemId: props.contextItemId,
        versionNumber: props.versionNumber,
        content: props.content ?? null,
        changeReason: 'approved',
        attestedBy: props.attestedBy,
        attestationHash: props.attestationHash,
        tenantId: props.tenantId,
        createdAt: new Date('2026-06-15T00:00:00.000Z'),
      })),
    },
  };
});

const TENANT = 'tenant-1';
const CONSULTATION = 'c-1';
const CONTEXT_ITEM = 'ci-1';

const cls = () => ({
  get: vi.fn((key: string) => {
    if (key === 'tenantId') return TENANT;
    if (key === 'user') return { id: 'doctor-1' };
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
        doctorId: 'doctor-1',
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
  },
  promptAssembly: { assemble: vi.fn() },
  harnessAudit: { append: vi.fn().mockResolvedValue({ id: 'a-1' }) },
});

/** Builds SummaryService with the mining queue in the LAST (trailing) slot. */
const build = (m: ReturnType<typeof makeMocks>, miningQueue?: unknown) =>
  new SummaryService(
    m.contextItemRepository as never,
    m.consultationRepository as never,
    m.summaryMetaRepository as never,
    m.namedEntityRepository as never,
    m.httpService as never,
    m.configService as never,
    m.eventEmitter as never,
    cls() as never,
    m.contextItemVersionRepository as never,
    m.promptAssembly as never,
    undefined, // secretsService
    undefined, // userProfileRepository
    m.harnessAudit as never, // harnessAuditService
    undefined, // harnessGatewayService
    undefined, // harnessPolicyService
    undefined, // configResolver
    undefined, // entitlements
    undefined, // trajectoryService
    undefined, // aiTaskDefaultService
    undefined, // transcriptSegmentRepository
    undefined, // usageLedger
    undefined, // unitOfWork
    undefined, // billing
    undefined, // departmentAgentRepository
    undefined, // aiModelRepository
    undefined, // noteGenerationService
    undefined, // phiRedactor
    miningQueue as never, // gateEditMiningQueue
  );

describe('SummaryService.approveSummary — gate-edit mining enqueue (W1)', () => {
  let m: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    vi.clearAllMocks();
    m = makeMocks();
  });

  it('enqueues the signed encounter for mining, carrying the ids the miner needs', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const service = build(m, { enqueue });

    await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = enqueue.mock.calls[0][0];
    expect(job.tenantId).toBe(TENANT);
    expect(job.consultationId).toBe(CONSULTATION);
    expect(job.contextItemId).toBe(CONTEXT_ITEM);
    // 'SIGNED' is a CLEAN_DECISIONS token in edit-burden.ts, so a clean
    // signature is never counted as a deferral.
    expect(job.gateDecision).toBe('SIGNED');
    expect(typeof job.signedAt).toBe('string');
  });

  it('does NOT fail the sign-off when the enqueue throws (R6 stays intact)', async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error('redis down'));
    const service = build(m, { enqueue });

    const result = await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(result.approvalStatus).toBe('APPROVED');
    // The consultation was still signed and still CAS-persisted.
    expect(m.consultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(m.harnessAudit.append).toHaveBeenCalled();
  });

  it('signs normally when no miner is wired at all (pre-ticket behaviour)', async () => {
    const service = build(m, undefined);

    const result = await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(result.approvalStatus).toBe('APPROVED');
    expect(m.consultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue on the idempotent replay of an already-approved summary', async () => {
    // An already-signed item returns early — re-mining it would rewrite the
    // exemplar for an encounter whose signature did not change.
    m.contextItemVersionRepository.getVersionsByChangeReason.mockResolvedValueOnce([
      { changedBy: 'doctor-1', createdAt: new Date('2026-06-15T00:00:00.000Z') },
    ]);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const service = build(m, { enqueue });

    await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(enqueue).not.toHaveBeenCalled();
  });
});
