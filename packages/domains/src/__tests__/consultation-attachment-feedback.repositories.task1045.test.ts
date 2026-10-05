/**
 * Attachment + feedback repositories — query and write shapes the attachment,
 * feedback, rollup and reaper services depend on.
 *
 *  - Feedback is append-only; a new rated fact on the same (tenant, actor,
 *    targetKey) flips the prior `isLatest` and links `supersedesId`, inside the
 *    caller's transaction.
 *  - The rollup aggregates EVENTS (every row in the window), PHI-free.
 *  - Attachment status moves are conditional (compare-and-set), so the reaper
 *    and a late `complete` can never both win.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsultationAttachmentStatus, FeedbackRating, FeedbackTargetKind, ResourceStatusType } from '../enums';

vi.mock('../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const makeUow = (delegates: Record<string, unknown>) => ({ getDatabaseService: () => delegates });

async function feedbackEntity(overrides: Record<string, unknown> = {}) {
  const { ConsultationFeedbackFactory } = await import('../factories/generated/core/ConsultationFeedbackFactory');
  return ConsultationFeedbackFactory.CreateConsultationFeedback({
    tenantId: 't-1',
    consultationId: 'c-1',
    actorUserId: 'u-1',
    actorCredentialClass: 'jwt',
    targetKind: FeedbackTargetKind.SECTION,
    targetContextItemId: 'ci-1',
    targetVersionNumber: 2,
    targetSectionKey: 'plan',
    targetKey: 'SECTION|ci-1|2|plan|',
    rating: FeedbackRating.DOWN,
    reasonCodes: ['missing_information'],
    ...overrides,
  } as never);
}

describe('ConsultationFeedbackRepository', () => {
  let delegate: Record<string, ReturnType<typeof vi.fn>>;
  let tx: { consultationFeedback: Record<string, ReturnType<typeof vi.fn>> };
  let repo: any;

  beforeEach(async () => {
    delegate = { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) };
    tx = {
      consultationFeedback: {
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockImplementation(async ({ data }) => ({ ...data })),
      },
    };
    const { ConsultationFeedbackRepository } = await import('../repositories/generated/core/ConsultationFeedbackRepository');
    repo = new ConsultationFeedbackRepository(makeUow({ consultationFeedback: delegate }) as never);
  });

  it('appendWithSupersede flips the prior latest rated row and links supersedesId, all through the tx', async () => {
    tx.consultationFeedback.findFirst.mockResolvedValue({ id: 'fb-old', tenantId: 't-1', consultationId: 'c-1', isLatest: true });
    const entity = await feedbackEntity();

    const result = await repo.appendWithSupersede(entity, tx);

    expect(tx.consultationFeedback.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 't-1', actorUserId: 'u-1', targetKey: 'SECTION|ci-1|2|plan|', isLatest: true, rating: { not: null } },
      orderBy: [{ createdAt: 'desc' }],
    });
    expect(tx.consultationFeedback.updateMany).toHaveBeenCalledWith({ where: { id: 'fb-old', isLatest: true }, data: { isLatest: false } });
    const created = tx.consultationFeedback.create.mock.calls[0][0].data;
    expect(created.supersedesId).toBe('fb-old');
    expect(created.isLatest).toBe(true);
    expect(created).not.toHaveProperty('version');
    expect(created).not.toHaveProperty('metaData');
    expect(created).not.toHaveProperty('updatedAt');
    expect(created).not.toHaveProperty('resourceStatus');
    expect(created).not.toHaveProperty('comment');
    expect(result.superseded?.id).toBe('fb-old');
    expect(result.saved.supersedesId).toBe('fb-old');
    expect(delegate.findFirst).not.toHaveBeenCalled();
  });

  it('appendWithSupersede leaves earlier rows alone for an unrated fact (comment / correction only)', async () => {
    const entity = await feedbackEntity({ rating: null, reasonCodes: [] });
    const result = await repo.appendWithSupersede(entity, tx);
    expect(tx.consultationFeedback.findFirst).not.toHaveBeenCalled();
    expect(tx.consultationFeedback.updateMany).not.toHaveBeenCalled();
    expect(result.superseded).toBeNull();
  });

  it('appendWithSupersede requires a transaction client', async () => {
    const entity = await feedbackEntity();
    await expect(repo.appendWithSupersede(entity, undefined)).rejects.toThrow();
  });

  it('findLatestByActorTarget reads the current rated row', async () => {
    await expect(repo.findLatestByActorTarget('t-1', 'u-1', 'k')).resolves.toBeNull();
    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 't-1', actorUserId: 'u-1', targetKey: 'k', isLatest: true, rating: { not: null } },
      orderBy: [{ createdAt: 'desc' }],
    });
  });

  it('listCursor pages newest first by (createdAt, id), latest-only by default', async () => {
    const rows = [
      { id: 'f3', createdAt: new Date('2026-10-05T10:03:00Z') },
      { id: 'f2', createdAt: new Date('2026-10-05T10:02:00Z') },
      { id: 'f1', createdAt: new Date('2026-10-05T10:01:00Z') },
    ];
    delegate.findMany.mockResolvedValue(rows);

    const page = await repo.listCursor('c-1', { limit: 2, targetKind: FeedbackTargetKind.SECTION, contextItemId: 'ci-1' });

    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { consultationId: 'c-1', isLatest: true, targetKind: FeedbackTargetKind.SECTION, targetContextItemId: 'ci-1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
    });
    expect(page.items.map((r: { id: string }) => r.id)).toEqual(['f3', 'f2']);
    expect(page.next).toEqual({ createdAt: rows[1].createdAt, id: 'f2' });
  });

  it('listCursor continues after a cursor and includes history on request', async () => {
    const after = { createdAt: new Date('2026-10-05T10:02:00Z'), id: 'f2' };
    const page = await repo.listCursor('c-1', { limit: 2, includeHistory: true, after });
    expect(delegate.findMany.mock.calls[0][0].where).toEqual({
      consultationId: 'c-1',
      OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: 'f2' } }],
    });
    expect(page).toEqual({ items: [], next: null });
  });

  it('aggregateEvents counts events per UTC day and dimension, plus one reasonedCount row per reason code', async () => {
    const day = new Date('2026-10-04T00:00:00.000Z');
    delegate.findMany.mockResolvedValue([
      {
        createdAt: new Date('2026-10-04T08:00:00Z'),
        targetKind: FeedbackTargetKind.SECTION,
        provAgentSlug: 'finalizer',
        provAgentVersion: 3,
        provModelName: 'gemma',
        provPromptVersion: '7',
        targetSectionKey: 'plan',
        entityLabel: null,
        rating: FeedbackRating.DOWN,
        reasonCodes: ['missing_information', 'too_long'],
        keyVersion: 1,
        correctionContextItemId: 'ci-9',
      },
      {
        createdAt: new Date('2026-10-04T09:00:00Z'),
        targetKind: FeedbackTargetKind.SECTION,
        provAgentSlug: 'finalizer',
        provAgentVersion: 3,
        provModelName: 'gemma',
        provPromptVersion: '7',
        targetSectionKey: 'plan',
        entityLabel: null,
        rating: FeedbackRating.UP,
        reasonCodes: [],
        keyVersion: null,
        correctionContextItemId: null,
      },
      {
        createdAt: new Date('2026-10-04T09:30:00Z'),
        targetKind: null, // consultation-level free text — not part of the rollup
        provAgentSlug: null,
        provAgentVersion: null,
        provModelName: null,
        provPromptVersion: null,
        targetSectionKey: null,
        entityLabel: null,
        rating: null,
        reasonCodes: [],
        keyVersion: 1,
        correctionContextItemId: null,
      },
    ]);

    const rows = await repo.aggregateEvents('t-1', day, new Date('2026-10-05T00:00:00.000Z'));

    const call = delegate.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ tenantId: 't-1', createdAt: { gte: day, lt: new Date('2026-10-05T00:00:00.000Z') } });
    expect(call.select).not.toHaveProperty('encryptedComment');
    expect(Object.keys(call.select)).not.toContain('targetEntityRef');

    const dims = {
      day,
      targetKind: FeedbackTargetKind.SECTION,
      agentSlug: 'finalizer',
      agentVersion: 3,
      modelName: 'gemma',
      promptVersion: '7',
      sectionKey: 'plan',
      entityLabel: '',
    };
    expect(rows).toEqual(
      expect.arrayContaining([
        { ...dims, reasonCode: '', upCount: 1, downCount: 1, clearedCount: 0, commentCount: 1, correctionCount: 1, reasonedCount: 0 },
        {
          ...dims,
          reasonCode: 'missing_information',
          upCount: 0,
          downCount: 0,
          clearedCount: 0,
          commentCount: 0,
          correctionCount: 0,
          reasonedCount: 1,
        },
        { ...dims, reasonCode: 'too_long', upCount: 0, downCount: 0, clearedCount: 0, commentCount: 0, correctionCount: 0, reasonedCount: 1 },
      ]),
    );
    expect(rows).toHaveLength(3);
  });
});

describe('ConsultationFeedbackDailyRollupRepository.replaceDay', () => {
  it('deletes the day and re-inserts its rows in the caller transaction', async () => {
    const { ConsultationFeedbackDailyRollupRepository } = await import('../repositories/generated/core/ConsultationFeedbackDailyRollupRepository');
    const { ConsultationFeedbackDailyRollupFactory } = await import('../factories/generated/core/ConsultationFeedbackDailyRollupFactory');
    const repo = new ConsultationFeedbackDailyRollupRepository(makeUow({}) as never);
    const day = new Date('2026-10-04T00:00:00.000Z');
    const tx = {
      consultationFeedbackDailyRollup: {
        deleteMany: vi.fn().mockResolvedValue({ count: 4 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const row = ConsultationFeedbackDailyRollupFactory.CreateConsultationFeedbackDailyRollup({
      tenantId: 't-1',
      day,
      targetKind: FeedbackTargetKind.NOTE,
      upCount: 2,
    } as never);

    await expect(repo.replaceDay('t-1', day, [row], tx)).resolves.toEqual({ deleted: 4, inserted: 1 });

    expect(tx.consultationFeedbackDailyRollup.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 't-1', day } });
    const data = tx.consultationFeedbackDailyRollup.createMany.mock.calls[0][0].data[0];
    expect(data).toMatchObject({ tenantId: 't-1', targetKind: FeedbackTargetKind.NOTE, upCount: 2, reasonCode: '', agentVersion: 0 });
    // The auto-mapper serialises dates to ISO strings (Prisma accepts both).
    expect(new Date(data.day).getTime()).toBe(day.getTime());
    for (const absent of ['version', 'metaData', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'resourceStatus']) {
      expect(data).not.toHaveProperty(absent);
    }
  });

  it('refuses a row for another tenant or day', async () => {
    const { ConsultationFeedbackDailyRollupRepository } = await import('../repositories/generated/core/ConsultationFeedbackDailyRollupRepository');
    const { ConsultationFeedbackDailyRollupFactory } = await import('../factories/generated/core/ConsultationFeedbackDailyRollupFactory');
    const repo = new ConsultationFeedbackDailyRollupRepository(makeUow({}) as never);
    const day = new Date('2026-10-04T00:00:00.000Z');
    const tx = { consultationFeedbackDailyRollup: { deleteMany: vi.fn(), createMany: vi.fn() } };
    const foreign = ConsultationFeedbackDailyRollupFactory.CreateConsultationFeedbackDailyRollup({
      tenantId: 't-2',
      day,
      targetKind: FeedbackTargetKind.NOTE,
    } as never);
    await expect(repo.replaceDay('t-1', day, [foreign], tx)).rejects.toThrow();
    expect(tx.consultationFeedbackDailyRollup.deleteMany).not.toHaveBeenCalled();
  });
});

describe('ConsultationAttachmentRepository', () => {
  let delegate: Record<string, ReturnType<typeof vi.fn>>;
  let repo: any;

  beforeEach(async () => {
    delegate = {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const { ConsultationAttachmentRepository } = await import('../repositories/generated/core/ConsultationAttachmentRepository');
    repo = new ConsultationAttachmentRepository(makeUow({ consultationAttachment: delegate }) as never);
  });

  it('findReapable: INTENT rows past their intent cutoff, cross-tenant, oldest first, capped', async () => {
    const now = new Date('2026-10-05T12:00:00Z');
    await repo.findReapable(now);
    expect(delegate.findMany).toHaveBeenCalledWith({
      skip: 0,
      take: 200,
      where: {
        status: ConsultationAttachmentStatus.INTENT,
        intentExpiresAt: { lt: now },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: [{ intentExpiresAt: 'asc' }],
      include: undefined,
    });
  });

  it('claimIntentToUploaded is a conditional flip — true only for the winner', async () => {
    await expect(repo.claimIntentToUploaded('a-1')).resolves.toBe(true);
    expect(delegate.updateMany).toHaveBeenCalledWith({
      where: { id: 'a-1', status: { in: [ConsultationAttachmentStatus.INTENT] } },
      data: { status: ConsultationAttachmentStatus.UPLOADED, version: { increment: 1 } },
    });

    delegate.updateMany.mockResolvedValue({ count: 0 });
    await expect(repo.claimIntentToUploaded('a-1')).resolves.toBe(false);
  });

  it('expireIntent flips INTENT → EXPIRED only (a claimed upload is never expired)', async () => {
    await repo.expireIntent('a-1');
    expect(delegate.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'a-1', status: { in: [ConsultationAttachmentStatus.INTENT] } },
      data: { status: ConsultationAttachmentStatus.EXPIRED, version: { increment: 1 } },
    });
  });

  it('findByIdempotencyKey looks up the replay row of one consultation', async () => {
    await expect(repo.findByIdempotencyKey('t-1', 'c-1', 'idem-1')).resolves.toBeNull();
    expect(delegate.findFirst.mock.calls[0][0].where).toEqual({ tenantId: 't-1', consultationId: 'c-1', idempotencyKey: 'idem-1' });
  });

  it('findByTranscriptionJobId resolves the attachment behind a batch STT job', async () => {
    await expect(repo.findByTranscriptionJobId('job-1')).resolves.toBeNull();
    expect(delegate.findFirst.mock.calls[0][0].where).toEqual({ transcriptionJobId: 'job-1', resourceStatus: ResourceStatusType.ENABLED });
  });
});
