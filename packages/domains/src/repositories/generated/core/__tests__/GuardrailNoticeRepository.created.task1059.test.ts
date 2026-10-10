/**
 * TASK-1059 RC-8 — `GuardrailNoticeRepository.upsertByDedupeKey` reports `created` from the INSERT, not
 * from comparing ids. Notice ids are deterministic (sha256(tenantId|dedupeKey), or the producer's own id
 * that is also its dedupe key), so a re-raise always arrives with the stored row's id — the old
 * `model.id === entity.id` answered `true` for every re-raise, and a RESOLVED notice re-entered the
 * guardrail hold with nothing open to resume (TASK-1058 E1-6).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuardrailDirection, GuardrailNoticeStatus, GuardrailNoticeType } from '../../../../enums';

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const makeUow = (delegates: Record<string, unknown>) => ({ getDatabaseService: () => delegates });

async function notice(overrides: Record<string, unknown> = {}) {
  const { GuardrailNoticeFactory } = await import('../../../../factories/generated/core/GuardrailNoticeFactory');
  const { GuardrailNoticeEntityMapper } = await import('../../../../mappers');
  const draft = GuardrailNoticeFactory.CreateGuardrailNotice({
    tenantId: 't-1',
    consultationId: 'c-1',
    type: GuardrailNoticeType.BLOCKED,
    direction: GuardrailDirection.OUTBOUND,
    action: 'block',
    checks: [{ checkId: 'pii_leak', category: 'encounter_id', severity: 'high' }],
    itemIds: [],
    messageKey: 'guardrail.blocked.generic',
    severity: 'high',
    policyVersion: 'pv-1',
    dedupeKey: 'n-deterministic',
    ...overrides,
  } as never);
  // The producer's deterministic id, exactly as `guardrailNoticeRow` builds it.
  const mapper = GuardrailNoticeEntityMapper.getInstance();
  return mapper.toDomainEntity({ ...(mapper.toPersistence(draft) as object), id: 'n-deterministic' } as never);
}

describe('GuardrailNoticeRepository.upsertByDedupeKey — created comes from the insert (RC-8)', () => {
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
      upsert: vi.fn().mockImplementation(async ({ create }) => stored ?? { ...create, version: 1 }),
    };
    const { GuardrailNoticeRepository } = await import('../GuardrailNoticeRepository');
    repo = new GuardrailNoticeRepository(makeUow({ guardrailNotice: delegate }) as never);
  });

  it('first raise: inserted (skipDuplicates, no version written), read back by (tenantId, dedupeKey), created', async () => {
    const entity = await notice();
    const { notice: saved, created } = await repo.upsertByDedupeKey(entity);

    expect(created).toBe(true);
    expect(saved.id).toBe('n-deterministic');
    const args = delegate.createMany.mock.calls[0][0];
    expect(args.skipDuplicates).toBe(true);
    expect(args.data).toHaveLength(1);
    expect(args.data[0]).toMatchObject({ id: 'n-deterministic', status: GuardrailNoticeStatus.OPEN });
    expect(args.data[0]).not.toHaveProperty('version');
    expect(delegate.findUnique).toHaveBeenCalledWith({
      where: { tenantId_dedupeKey: { tenantId: 't-1', dedupeKey: 'n-deterministic' } },
    });
  });

  it('a RESOLVED notice re-raised under the same deterministic id is NOT created and is returned as stored', async () => {
    const original = await notice();
    stored = {
      ...(await import('../../../../mappers')).GuardrailNoticeEntityMapper.getInstance().toPersistence(original),
      id: 'n-deterministic',
      status: GuardrailNoticeStatus.RESOLVED,
      resolution: 'acknowledged',
      version: 3,
    };
    const { notice: saved, created } = await repo.upsertByDedupeKey(await notice());

    expect(created).toBe(false);
    expect(saved.id).toBe('n-deterministic');
    expect(saved.status).toBe(GuardrailNoticeStatus.RESOLVED);
  });

  it('an ACKNOWLEDGED notice re-raised is not created either', async () => {
    stored = { id: 'n-deterministic', tenantId: 't-1', dedupeKey: 'n-deterministic', status: GuardrailNoticeStatus.ACKNOWLEDGED, checks: [], itemIds: [], version: 2 };
    const { created } = await repo.upsertByDedupeKey(await notice());
    expect(created).toBe(false);
  });

  it('routes both statements through a supplied transaction client', async () => {
    const tx = {
      guardrailNotice: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockImplementation(async ({ where }) => ({ id: 'n-deterministic', tenantId: where.tenantId_dedupeKey.tenantId, checks: [], itemIds: [] })),
      },
    };
    const { created } = await repo.upsertByDedupeKey(await notice(), tx);
    expect(created).toBe(true);
    expect(tx.guardrailNotice.createMany).toHaveBeenCalledTimes(1);
    expect(tx.guardrailNotice.findUnique).toHaveBeenCalledTimes(1);
    expect(delegate.createMany).not.toHaveBeenCalled();
    expect(delegate.findUnique).not.toHaveBeenCalled();
  });
});
