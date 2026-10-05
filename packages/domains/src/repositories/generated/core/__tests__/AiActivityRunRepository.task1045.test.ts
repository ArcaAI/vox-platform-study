/**
 * AiActivityRunRepository — the durable run record is an idempotent upsert on
 * `runKey`, and `findProducerOf` answers "which run produced this item
 * version".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiActivityKind, AiActivityRunStatus } from '../../../../enums';

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const makeUow = (delegates: Record<string, unknown>) => ({ getDatabaseService: () => delegates });

async function run(overrides: Record<string, unknown> = {}) {
  const { AiActivityRunFactory } = await import('../../../../factories/generated/core/AiActivityRunFactory');
  return AiActivityRunFactory.CreateAiActivityRun({
    tenantId: 't-1',
    runKey: 'harness:sess-1:run-1:3',
    consultationId: 'c-1',
    encounterSeq: 1,
    activityKind: AiActivityKind.NOTE_GENERATE,
    status: AiActivityRunStatus.OK,
    startedAt: new Date('2026-10-05T10:00:00Z'),
    endedAt: new Date('2026-10-05T10:00:05Z'),
    durationMs: 5000,
    tokensIn: 1200,
    tokensOut: 300,
    contextItemId: 'ci-note',
    outputVersionNumber: 2,
    ...overrides,
  } as never);
}

describe('AiActivityRunRepository', () => {
  let delegate: Record<string, ReturnType<typeof vi.fn>>;
  let repo: any;

  beforeEach(async () => {
    delegate = {
      upsert: vi.fn().mockImplementation(async ({ create }) => ({ ...create })),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    };
    const { AiActivityRunRepository } = await import('../AiActivityRunRepository');
    repo = new AiActivityRunRepository(makeUow({ aiActivityRun: delegate }) as never);
  });

  it('upsertByRunKey creates on the first write and updates only the run outcome on a replay', async () => {
    const entity = await run();
    const saved = await repo.upsertByRunKey(entity);

    const args = delegate.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ runKey: 'harness:sess-1:run-1:3' });
    expect(args.create).toMatchObject({ id: entity.id, tenantId: 't-1', runKey: 'harness:sess-1:run-1:3', tokensIn: 1200 });
    for (const absent of ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy']) {
      expect(args.create).not.toHaveProperty(absent);
      expect(args.update).not.toHaveProperty(absent);
    }
    // Identity never moves on a replay.
    for (const identity of ['id', 'tenantId', 'runKey', 'createdAt', 'createdBy']) {
      expect(args.update).not.toHaveProperty(identity);
    }
    expect(args.update).toMatchObject({ status: AiActivityRunStatus.OK, tokensOut: 300, outputVersionNumber: 2 });
    expect(saved.runKey).toBe('harness:sess-1:run-1:3');
  });

  it('upsertByRunKey is idempotent: two writes of the same runKey hit the same unique key', async () => {
    await repo.upsertByRunKey(await run({ status: AiActivityRunStatus.ERROR, errorCode: 'TIMEOUT' }));
    await repo.upsertByRunKey(await run());
    expect(delegate.upsert).toHaveBeenCalledTimes(2);
    expect(delegate.upsert.mock.calls.map((c) => c[0].where)).toEqual([{ runKey: 'harness:sess-1:run-1:3' }, { runKey: 'harness:sess-1:run-1:3' }]);
  });

  it('upsertByRunKey routes through a supplied transaction client', async () => {
    const tx = { aiActivityRun: { upsert: vi.fn().mockImplementation(async ({ create }) => ({ ...create })) } };
    await repo.upsertByRunKey(await run(), tx);
    expect(tx.aiActivityRun.upsert).toHaveBeenCalledTimes(1);
    expect(delegate.upsert).not.toHaveBeenCalled();
  });

  it('findProducerOf matches the exact item version when given', async () => {
    delegate.findFirst.mockResolvedValue({ id: 'r-1', runKey: 'k', contextItemId: 'ci-note', outputVersionNumber: 2 });
    const producer = await repo.findProducerOf({ tenantId: 't-1', contextItemId: 'ci-note', versionNumber: 2 });
    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 't-1', contextItemId: 'ci-note', outputVersionNumber: 2 },
      orderBy: [{ outputVersionNumber: 'desc' }, { startedAt: 'desc' }],
    });
    expect(producer.id).toBe('r-1');
  });

  it('findProducerOf without a version returns the newest producing run, and null on a miss', async () => {
    await expect(repo.findProducerOf({ tenantId: 't-1', contextItemId: 'ci-x', consultationId: 'c-1' })).resolves.toBeNull();
    expect(delegate.findFirst.mock.calls[0][0].where).toEqual({ tenantId: 't-1', contextItemId: 'ci-x', consultationId: 'c-1' });
  });

  it('findByConsultation lists the consultation runs in start order', async () => {
    await repo.findByConsultation('t-1', 'c-1');
    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { tenantId: 't-1', consultationId: 'c-1' },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('findByRunKey reads one record by its idempotency key', async () => {
    await expect(repo.findByRunKey('k-1')).resolves.toBeNull();
    expect(delegate.findFirst).toHaveBeenCalledWith({ where: { runKey: 'k-1' } });
  });
});
