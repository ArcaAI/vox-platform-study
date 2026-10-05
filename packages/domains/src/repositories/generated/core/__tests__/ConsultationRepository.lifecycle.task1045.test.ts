/**
 * ConsultationRepository + ContextItemRepository — lifecycle / record-model
 * query and write shapes.
 *
 * The no-version-bump writers (`touchActivity`, `setProcessing`,
 * `allocateSegmentSeqs`, `advanceRecordingCursor`) must NEVER put `version`
 * in the Prisma payload: processing and activity churn would otherwise turn
 * every client's If-Match stale.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsultationProcessing, ConsultationStatus, ContextItemType, ResourceStatusType } from '../../../../enums';

vi.mock('../../../../mappers', () => ({
  ConsultationEntityMapper: { getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }) },
  ConsultationEncounterEntityMapper: { getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }) },
  ConsultationApprovalEntityMapper: { getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }) },
  ContextItemEntityMapper: {
    getInstance: () => ({
      toDomainEntity: (m: Record<string, unknown>) => m,
      toPersistence: (e: Record<string, unknown>) => ({ ...e }),
    }),
  },
}));

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const makeUow = (delegates: Record<string, unknown>) => ({ getDatabaseService: () => delegates });

const CLOSED = [ConsultationStatus.CLOSED_COMPLETE, ConsultationStatus.CLOSED_INCOMPLETE];

function payloadHasVersion(call: unknown[]): boolean {
  const args = call[0] as { data?: Record<string, unknown> };
  return Object.prototype.hasOwnProperty.call(args.data ?? {}, 'version');
}

describe('ConsultationRepository — no-version-bump writers', () => {
  let delegate: Record<string, ReturnType<typeof vi.fn>>;
  let repo: any;

  beforeEach(async () => {
    delegate = {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const { ConsultationRepository } = await import('../ConsultationRepository');
    repo = new ConsultationRepository(makeUow({ consultation: delegate }) as never);
  });

  it('touchActivity moves lastActivityAt forward only, without a version bump', async () => {
    const at = new Date('2026-10-05T10:00:00.000Z');
    await expect(repo.touchActivity('c-1', at)).resolves.toBe(true);
    expect(delegate.updateMany).toHaveBeenCalledWith({
      where: { id: 'c-1', lastActivityAt: { lt: at } },
      data: { lastActivityAt: at },
    });
    expect(payloadHasVersion(delegate.updateMany.mock.calls[0])).toBe(false);
  });

  it('touchActivity routes through a supplied transaction client', async () => {
    const tx = { consultation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } };
    await expect(repo.touchActivity('c-1', new Date(), tx)).resolves.toBe(false);
    expect(tx.consultation.updateMany).toHaveBeenCalledTimes(1);
    expect(delegate.updateMany).not.toHaveBeenCalled();
  });

  it('setProcessing writes processing + reason rule + stamp (+ refs/prior when given), without a version bump', async () => {
    await repo.setProcessing('c-1', ConsultationProcessing.FAILED, { reason: 'RESUME_READ_FAILED', refs: [], prior: null });
    const args = delegate.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'c-1' });
    expect(args.data).toMatchObject({
      processing: ConsultationProcessing.FAILED,
      processingReason: 'RESUME_READ_FAILED',
      processingRefs: [],
      processingPrior: null,
    });
    expect(args.data.processingUpdatedAt).toBeInstanceOf(Date);
    expect(payloadHasVersion(delegate.updateMany.mock.calls[0])).toBe(false);

    await repo.setProcessing('c-1', ConsultationProcessing.SUMMARIZING, { reason: 'dropped' });
    const second = delegate.updateMany.mock.calls[1][0];
    expect(second.data.processingReason).toBeNull();
    expect(second.data).not.toHaveProperty('processingRefs');
    expect(second.data).not.toHaveProperty('processingPrior');
  });

  it('allocateSegmentSeqs increments the head atomically and returns the allocated range', async () => {
    delegate.update.mockResolvedValue({ segmentSeqHead: 12 });
    await expect(repo.allocateSegmentSeqs('c-1', 3)).resolves.toEqual({ first: 10, last: 12 });
    expect(delegate.update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: { segmentSeqHead: { increment: 3 } },
      select: { segmentSeqHead: true },
    });
    expect(payloadHasVersion(delegate.update.mock.calls[0])).toBe(false);
  });

  it('allocateSegmentSeqs refuses a non-positive count without touching the row', async () => {
    await expect(repo.allocateSegmentSeqs('c-1', 0)).rejects.toThrow();
    expect(delegate.update).not.toHaveBeenCalled();
  });

  it('advanceRecordingCursor increments the timeline and returns the part position', async () => {
    delegate.update.mockResolvedValue({ recordingCursorMs: 95_000 });
    await expect(repo.advanceRecordingCursor('c-1', 35_000)).resolves.toEqual({ startMs: 60_000, endMs: 95_000 });
    expect(delegate.update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: { recordingCursorMs: { increment: 35_000 } },
      select: { recordingCursorMs: true },
    });
    expect(payloadHasVersion(delegate.update.mock.calls[0])).toBe(false);
  });
});

describe('ConsultationRepository — lifecycle reads', () => {
  let delegate: Record<string, ReturnType<typeof vi.fn>>;
  let repo: any;

  beforeEach(async () => {
    delegate = { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) };
    const { ConsultationRepository } = await import('../ConsultationRepository');
    repo = new ConsultationRepository(makeUow({ consultation: delegate }) as never);
  });

  it('findOpenByKey matches the non-closed row null-safely on department, newest first', async () => {
    delegate.findFirst.mockResolvedValue({ id: 'c-open' });
    await expect(repo.findOpenByKey({ tenantId: 't', doctorId: 'd', patientId: 'p' })).resolves.toEqual({ id: 'c-open' });
    const args = delegate.findFirst.mock.calls[0][0];
    expect(args.where).toEqual({
      tenantId: 't',
      doctorId: 'd',
      patientId: 'p',
      departmentId: null,
      status: { notIn: CLOSED },
      resourceStatus: ResourceStatusType.ENABLED,
    });
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }]);
  });

  it('findOpenByKey returns null on a miss and keeps a named department', async () => {
    await expect(repo.findOpenByKey({ tenantId: 't', doctorId: 'd', patientId: 'p', departmentId: 'dep' })).resolves.toBeNull();
    expect(delegate.findFirst.mock.calls[0][0].where.departmentId).toBe('dep');
  });

  it('findLatestClosedByKey reads the newest closed row of the same key', async () => {
    await expect(repo.findLatestClosedByKey({ tenantId: 't', doctorId: 'd', patientId: 'p', departmentId: null })).resolves.toBeNull();
    const args = delegate.findFirst.mock.calls[0][0];
    expect(args.where.status).toEqual({ in: CLOSED });
    expect(args.where.departmentId).toBeNull();
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }]);
  });

  it('findAutoCloseEligible: every non-closed row idle past the cutoff, cross-tenant, oldest first, capped', async () => {
    const cutoff = new Date('2026-10-05T00:00:00.000Z');
    await repo.findAutoCloseEligible(cutoff);
    expect(delegate.findMany).toHaveBeenCalledWith({
      skip: 0,
      take: 200,
      where: {
        status: { notIn: CLOSED },
        lastActivityAt: { lt: cutoff },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: [{ lastActivityAt: 'asc' }],
      include: undefined,
    });
  });

  it('findAutoCloseEligible narrows to a tenant and honours a custom limit', async () => {
    await repo.findAutoCloseEligible(new Date(), { tenantId: 't', limit: 50 });
    const args = delegate.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe('t');
    expect(args.take).toBe(50);
  });

  it('findStaleRecording keys on lastActivityAt, not updatedAt', async () => {
    const cutoff = new Date('2026-10-05T00:00:00.000Z');
    await repo.findStaleRecording(cutoff);
    const args = delegate.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      status: ConsultationStatus.RECORDING,
      lastActivityAt: { lt: cutoff },
      resourceStatus: ResourceStatusType.ENABLED,
    });
    expect(args.orderBy).toEqual([{ lastActivityAt: 'asc' }]);
  });

  it('findPendingReviewForTenant reads STOPPED rows awaiting review', async () => {
    await repo.findPendingReviewForTenant('t');
    expect(delegate.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 't',
      status: ConsultationStatus.STOPPED,
      processing: ConsultationProcessing.AWAITING_REVIEW,
      resourceStatus: ResourceStatusType.ENABLED,
    });
  });
});

describe('ContextItemRepository — transcript record reads/writes', () => {
  let delegate: Record<string, ReturnType<typeof vi.fn>>;
  let repo: any;

  beforeEach(async () => {
    delegate = {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const { ContextItemRepository } = await import('../ContextItemRepository');
    repo = new ContextItemRepository(makeUow({ contextItem: delegate }) as never);
  });

  it('findSegments orders TRANSCRIPT_SEGMENT rows by segmentSeq with optional encounter/range filters', async () => {
    await repo.findSegments('c-1');
    expect(delegate.findMany.mock.calls[0][0]).toEqual({
      where: { consultationId: 'c-1', type: ContextItemType.TRANSCRIPT_SEGMENT, resourceStatus: ResourceStatusType.ENABLED },
      orderBy: [{ segmentSeq: 'asc' }],
    });

    await repo.findSegments('c-1', { encounterSeq: 2, fromSeq: 10, toSeq: 20 });
    expect(delegate.findMany.mock.calls[1][0].where).toEqual({
      consultationId: 'c-1',
      type: ContextItemType.TRANSCRIPT_SEGMENT,
      resourceStatus: ResourceStatusType.ENABLED,
      encounterSeq: 2,
      segmentSeq: { gte: 10, lte: 20 },
    });
  });

  it('findFullTranscript reads the single live FULL_TRANSCRIPT item', async () => {
    delegate.findFirst.mockResolvedValue({ id: 'ft' });
    await expect(repo.findFullTranscript('c-1')).resolves.toEqual({ id: 'ft' });
    expect(delegate.findFirst.mock.calls[0][0].where).toEqual({
      consultationId: 'c-1',
      type: ContextItemType.FULL_TRANSCRIPT,
      resourceStatus: ResourceStatusType.ENABLED,
    });
  });

  it('findEncounterArtifact reads the live ledger/recap of one encounter', async () => {
    await expect(repo.findEncounterArtifact('c-1', ContextItemType.FACT_LEDGER, 2)).resolves.toBeNull();
    expect(delegate.findFirst.mock.calls[0][0].where).toEqual({
      consultationId: 'c-1',
      type: ContextItemType.FACT_LEDGER,
      encounterSeq: 2,
      resourceStatus: ResourceStatusType.ENABLED,
    });
  });

  it('createSegmentsBatch inserts with skipDuplicates and reports which segment keys were new', async () => {
    const segments = [
      { id: 's-1', consultationId: 'c-1', segmentKey: 'sess:0' },
      { id: 's-2', consultationId: 'c-1', segmentKey: 'sess:1' },
    ];
    delegate.createMany.mockResolvedValue({ count: 1 });
    delegate.findMany.mockResolvedValue([{ id: 's-2', segmentKey: 'sess:1' }]);

    const result = await repo.createSegmentsBatch(segments);

    expect(delegate.createMany).toHaveBeenCalledWith({ data: segments, skipDuplicates: true });
    expect(delegate.findMany).toHaveBeenCalledWith({ where: { id: { in: ['s-1', 's-2'] } }, orderBy: [{ segmentSeq: 'asc' }] });
    expect(result.inserted).toEqual([{ id: 's-2', segmentKey: 'sess:1' }]);
    expect(result.duplicateKeys).toEqual(['sess:0']);
  });

  it('createSegmentsBatch refuses a segment without a segmentKey (idempotency is the contract)', async () => {
    await expect(repo.createSegmentsBatch([{ id: 's-1', consultationId: 'c-1', segmentKey: null }])).rejects.toThrow();
    expect(delegate.createMany).not.toHaveBeenCalled();
  });

  it('createSegmentsBatch is a no-op for an empty batch', async () => {
    await expect(repo.createSegmentsBatch([])).resolves.toEqual({ inserted: [], duplicateKeys: [] });
    expect(delegate.createMany).not.toHaveBeenCalled();
  });
});

describe('ConsultationEncounterRepository / ConsultationApprovalRepository', () => {
  it('findByExternalRef reads the tenant encounters of a visit id with their consultation, newest first', async () => {
    const delegate = { findMany: vi.fn().mockResolvedValue([]) };
    const { ConsultationEncounterRepository } = await import('../ConsultationEncounterRepository');
    const repo = new ConsultationEncounterRepository(makeUow({ consultationEncounter: delegate }) as never);
    await repo.findByExternalRef('t', 'emr-1');
    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { tenantId: 't', externalRef: 'emr-1' },
      include: { Consultation: true },
      orderBy: [{ createdAt: 'desc' }],
    });
  });

  it('endEncounter ends only a still-open encounter and reports whether it did', async () => {
    const delegate = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const { ConsultationEncounterRepository } = await import('../ConsultationEncounterRepository');
    const repo = new ConsultationEncounterRepository(makeUow({ consultationEncounter: delegate }) as never);
    const endedAt = new Date('2026-10-05T11:00:00Z');
    await expect(repo.endEncounter('c-1', 2, { endedAt, recordingEndMs: 90_000 })).resolves.toBe(true);
    expect(delegate.updateMany).toHaveBeenCalledWith({
      where: { consultationId: 'c-1', seq: 2, endedAt: null },
      data: { endedAt, recordingEndMs: 90_000 },
    });
  });

  it('findLatestByConsultation reads the newest approval snapshot', async () => {
    const delegate = { findFirst: vi.fn().mockResolvedValue(null) };
    const { ConsultationApprovalRepository } = await import('../ConsultationApprovalRepository');
    const repo = new ConsultationApprovalRepository(makeUow({ consultationApproval: delegate }) as never);
    await expect(repo.findLatestByConsultation('c-1')).resolves.toBeNull();
    expect(delegate.findFirst).toHaveBeenCalledWith({ where: { consultationId: 'c-1' }, orderBy: [{ approvedAt: 'desc' }] });
  });
});
