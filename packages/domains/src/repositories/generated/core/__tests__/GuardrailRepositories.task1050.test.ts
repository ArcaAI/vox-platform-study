/**
 * TASK-1050 W0 — repository methods for the guardrail plane.
 *
 *   • GuardrailEvaluationRepository.createManyIdempotent: one `createMany` with
 *     `skipDuplicates`, so a redriven outbox batch (at-least-once, §9.8.2) never duplicates and
 *     never errors on an id already stored; it reports which ids were new.
 *   • GuardrailNoticeRepository.upsertByDedupeKey: keyed on `(tenantId, dedupeKey)`; a repeat
 *     raise of the same notice is a NO-OP that returns the stored row (an acknowledged notice
 *     must never be reset to OPEN by the next live-summary tick) and says it was not created.
 *     Since TASK-1059 RC-8 `created` is the insert's row count (createMany + skipDuplicates),
 *     then the row is read back by the key (see GuardrailNoticeRepository.created.task1059.test.ts).
 *   • GuardrailNoticeRepository.findOpenByConsultation: tenant + consultation + OPEN, oldest first.
 *   • ContextItemRepository.setGuardrailStatus(+Many): updates ONLY that column — no `_version`
 *     increment (OD-21), routed through a supplied transaction client.
 *   • GuardrailPolicyRevisionRepository: newest-first history per (model, key).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuardrailDecision, GuardrailDirection, GuardrailItemStatus, GuardrailNoticeStatus, GuardrailNoticeType } from '../../../../enums';

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const makeUow = (delegates: Record<string, unknown>) => ({ getDatabaseService: () => delegates });

async function evaluation(id: string, overrides: Record<string, unknown> = {}) {
  const { GuardrailEvaluationFactory } = await import('../../../../factories/generated/core/GuardrailEvaluationFactory');
  return GuardrailEvaluationFactory.CreateGuardrailEvaluation({
    id,
    tenantId: 't-1',
    requestId: 'req-1',
    consultationId: 'c-1',
    caller: 'harness.guardrail_check',
    direction: GuardrailDirection.INBOUND,
    decision: GuardrailDecision.ALLOW,
    checks: [],
    policyVersion: 'pv-1',
    at: new Date('2026-10-07T10:00:00Z'),
    ...overrides,
  } as never);
}

async function notice(overrides: Record<string, unknown> = {}) {
  const { GuardrailNoticeFactory } = await import('../../../../factories/generated/core/GuardrailNoticeFactory');
  return GuardrailNoticeFactory.CreateGuardrailNotice({
    tenantId: 't-1',
    consultationId: 'c-1',
    type: GuardrailNoticeType.WARNING,
    direction: GuardrailDirection.OUTBOUND,
    action: 'warn',
    checks: [{ checkId: 'safety.self_harm', category: 'self_harm', severity: 'medium' }],
    itemIds: ['ci-1'],
    messageKey: 'guardrail.warning.generic',
    severity: 'medium',
    policyVersion: 'pv-1',
    dedupeKey: 'c-1|safety.self_harm|ci-1|pv-1',
    ...overrides,
  } as never);
}

describe('GuardrailEvaluationRepository.createManyIdempotent', () => {
  let delegate: Record<string, ReturnType<typeof vi.fn>>;
  let repo: any;

  beforeEach(async () => {
    delegate = {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    };
    const { GuardrailEvaluationRepository } = await import('../GuardrailEvaluationRepository');
    repo = new GuardrailEvaluationRepository(makeUow({ guardrailEvaluation: delegate }) as never);
  });

  it('writes the batch once with skipDuplicates on the caller-supplied ids', async () => {
    const rows = [await evaluation('ev-1'), await evaluation('ev-2', { direction: GuardrailDirection.OUTBOUND })];
    delegate.createMany.mockResolvedValue({ count: 2 });
    const result = await repo.createManyIdempotent(rows);

    expect(delegate.createMany).toHaveBeenCalledTimes(1);
    const args = delegate.createMany.mock.calls[0][0];
    expect(args.skipDuplicates).toBe(true);
    expect(args.data.map((row: any) => row.id)).toEqual(['ev-1', 'ev-2']);
    for (const row of args.data) {
      for (const absent of ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy']) {
        expect(row).not.toHaveProperty(absent);
      }
    }
    expect(result).toEqual({ inserted: 2, duplicates: 0 });
  });

  it('a redriven batch reports its already-stored rows as duplicates, never an error', async () => {
    delegate.createMany.mockResolvedValue({ count: 1 });
    const result = await repo.createManyIdempotent([await evaluation('ev-1'), await evaluation('ev-2')]);
    expect(result).toEqual({ inserted: 1, duplicates: 1 });
  });

  it('an empty batch touches nothing', async () => {
    expect(await repo.createManyIdempotent([])).toEqual({ inserted: 0, duplicates: 0 });
    expect(delegate.createMany).not.toHaveBeenCalled();
  });

  it('routes through a supplied transaction client', async () => {
    const tx = { guardrailEvaluation: { createMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    await repo.createManyIdempotent([await evaluation('ev-1')], tx);
    expect(tx.guardrailEvaluation.createMany).toHaveBeenCalledTimes(1);
    expect(delegate.createMany).not.toHaveBeenCalled();
  });

  it('findByConsultation reads tenant + consultation in evaluation order', async () => {
    await repo.findByConsultation('t-1', 'c-1');
    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { tenantId: 't-1', consultationId: 'c-1' },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
  });
});

describe('GuardrailNoticeRepository', () => {
  let delegate: Record<string, ReturnType<typeof vi.fn>>;
  let repo: any;
  let stored: Record<string, unknown> | null;

  beforeEach(async () => {
    stored = null;
    delegate = {
      createMany: vi.fn().mockImplementation(async ({ data }) => {
        if (stored) return { count: 0 };
        stored = { ...data[0], version: 1 };
        return { count: 1 };
      }),
      findUnique: vi.fn().mockImplementation(async () => stored),
      findMany: vi.fn().mockResolvedValue([]),
    };
    const { GuardrailNoticeRepository } = await import('../GuardrailNoticeRepository');
    repo = new GuardrailNoticeRepository(makeUow({ guardrailNotice: delegate }) as never);
  });

  it('upsertByDedupeKey creates on first raise, keyed on (tenantId, dedupeKey)', async () => {
    const entity = await notice();
    const { notice: saved, created } = await repo.upsertByDedupeKey(entity);

    const args = delegate.createMany.mock.calls[0][0];
    expect(args.skipDuplicates).toBe(true);
    expect(args.data[0]).toMatchObject({ id: entity.id, status: GuardrailNoticeStatus.OPEN, itemIds: ['ci-1'] });
    expect(args.data[0]).not.toHaveProperty('version');
    expect(delegate.findUnique.mock.calls[0][0].where).toEqual({
      tenantId_dedupeKey: { tenantId: 't-1', dedupeKey: 'c-1|safety.self_harm|ci-1|pv-1' },
    });
    expect(created).toBe(true);
    expect(saved.id).toBe(entity.id);
  });

  it('a repeat raise is a no-op that returns the stored (possibly acknowledged) notice', async () => {
    stored = {
      ...(await notice()),
      id: 'n-existing',
      tenantId: 't-1',
      status: GuardrailNoticeStatus.ACKNOWLEDGED,
      acknowledgedBy: 'u-doctor',
      checks: [],
      itemIds: ['ci-1'],
      version: 2,
    };
    const { notice: saved, created } = await repo.upsertByDedupeKey(await notice());
    expect(created).toBe(false);
    expect(saved.id).toBe('n-existing');
    expect(saved.status).toBe(GuardrailNoticeStatus.ACKNOWLEDGED);
  });

  it('upsertByDedupeKey routes through a supplied transaction client', async () => {
    const tx = {
      guardrailNotice: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ id: 'n-1', tenantId: 't-1', checks: [], itemIds: [] }),
      },
    };
    await repo.upsertByDedupeKey(await notice(), tx);
    expect(tx.guardrailNotice.createMany).toHaveBeenCalledTimes(1);
    expect(delegate.createMany).not.toHaveBeenCalled();
  });

  it('findOpenByConsultation filters tenant + consultation + OPEN, oldest first', async () => {
    await repo.findOpenByConsultation('t-1', 'c-1');
    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { tenantId: 't-1', consultationId: 'c-1', status: GuardrailNoticeStatus.OPEN },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });
});

describe('ContextItemRepository.setGuardrailStatus — outside OCC (OD-21)', () => {
  let delegate: Record<string, ReturnType<typeof vi.fn>>;
  let repo: any;

  beforeEach(async () => {
    delegate = { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 2 }) };
    const { ContextItemRepository } = await import('../ContextItemRepository');
    repo = new ContextItemRepository(makeUow({ contextItem: delegate }) as never);
  });

  it('updates exactly the guardrailStatus column and never increments _version', async () => {
    await repo.setGuardrailStatus('ci-1', GuardrailItemStatus.WARNED);
    expect(delegate.update).toHaveBeenCalledWith({ where: { id: 'ci-1' }, data: { guardrailStatus: GuardrailItemStatus.WARNED } });
    const { data } = delegate.update.mock.calls[0][0];
    expect(Object.keys(data)).toEqual(['guardrailStatus']);
    expect(data).not.toHaveProperty('version');
  });

  it('routes through a supplied transaction client', async () => {
    const tx = { contextItem: { update: vi.fn().mockResolvedValue({}) } };
    await repo.setGuardrailStatus('ci-1', GuardrailItemStatus.BLOCKED, tx);
    expect(tx.contextItem.update).toHaveBeenCalledWith({ where: { id: 'ci-1' }, data: { guardrailStatus: GuardrailItemStatus.BLOCKED } });
    expect(delegate.update).not.toHaveBeenCalled();
  });

  it('setGuardrailStatusMany marks every item of a transcript window in one write, no _version', async () => {
    const count = await repo.setGuardrailStatusMany(['ci-1', 'ci-2'], GuardrailItemStatus.BLOCKED);
    expect(delegate.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['ci-1', 'ci-2'] } },
      data: { guardrailStatus: GuardrailItemStatus.BLOCKED },
    });
    expect(count).toBe(2);
    expect(await repo.setGuardrailStatusMany([], GuardrailItemStatus.BLOCKED)).toBe(0);
    expect(delegate.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('GuardrailPolicyRevisionRepository', () => {
  let delegate: Record<string, ReturnType<typeof vi.fn>>;
  let repo: any;

  beforeEach(async () => {
    delegate = { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) };
    const { GuardrailPolicyRevisionRepository } = await import('../GuardrailPolicyRevisionRepository');
    repo = new GuardrailPolicyRevisionRepository(makeUow({ guardrailPolicyRevision: delegate }) as never);
  });

  it('listByKey returns the history of one (model, key) newest first, bounded', async () => {
    await repo.listByKey('model-1', 'judgeTemperature', 20);
    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { aiModelId: 'model-1', policyKey: 'judgeTemperature' },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: 20,
    });
  });

  it('findLatestByKey returns null when the key was never revised', async () => {
    expect(await repo.findLatestByKey('model-1', 'judgeTemperature')).toBeNull();
    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: { aiModelId: 'model-1', policyKey: 'judgeTemperature' },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
    });
  });
});
