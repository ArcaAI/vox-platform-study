/**
 * `ContextItemRepository.findLatestByKindKey` — the read by TENANT-DECLARED KIND.
 *
 * Every existing finder on this repository selects by `ContextItemType`, which is the PLATFORM's
 * vocabulary. What a client states at `open` is addressed by `kindKey`, the name the tenant's own
 * consultation-context schema declares, and there was no finder for it: the only way to reach one
 * was `findByConsultation` — every context item of the consultation, transcripts included — plus
 * an in-memory scan. On the summary path that is a whole encounter's rows read to answer a
 * question the `ContextItem_consultation_kindKey_idx` index answers directly.
 *
 * What the shape below pins:
 *   • the kind key is filtered in the DATABASE, never after the fact;
 *   • NEWEST wins (`createdAt` descending) — a kind declared `ONE` is written once at `open`, but a
 *     re-open or a correction can leave two rows, and a prompt must carry what the client last
 *     said;
 *   • soft-deleted rows never resurface;
 *   • a transaction client, when supplied, is what the read routes through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceStatusType } from '../../../../enums';

vi.mock('../../../../mappers', () => ({
  ContextItemEntityMapper: {
    getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => ({ ...m, mapped: true }) }),
  },
}));

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const makeUow = (delegateByModel: Record<string, any>) => ({ getDatabaseService: () => delegateByModel });

describe('ContextItemRepository.findLatestByKindKey', () => {
  let delegate: any;
  let repo: any;

  beforeEach(async () => {
    delegate = { findFirst: vi.fn().mockResolvedValue(null) };
    const { ContextItemRepository } = await import('../ContextItemRepository');
    repo = new ContextItemRepository(makeUow({ contextItem: delegate }) as never);
  });

  it('filters on consultation + kindKey + ENABLED, newest first', async () => {
    await repo.findLatestByKindKey('consultation-1', 'vitals');

    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: {
        consultationId: 'consultation-1',
        kindKey: 'vitals',
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('maps the row it finds through the entity mapper', async () => {
    delegate.findFirst.mockResolvedValue({ id: 'ci-1', kindKey: 'vitals' });

    await expect(repo.findLatestByKindKey('consultation-1', 'vitals')).resolves.toEqual({ id: 'ci-1', kindKey: 'vitals', mapped: true });
  });

  it('answers null when the consultation has no item of that kind', async () => {
    await expect(repo.findLatestByKindKey('consultation-1', 'previous_case_notes')).resolves.toBeNull();
  });

  it('answers null rather than throwing when the read fails — the callers are prompt context, not preconditions', async () => {
    delegate.findFirst.mockRejectedValue(new Error('connection refused'));

    await expect(repo.findLatestByKindKey('consultation-1', 'vitals')).resolves.toBeNull();
  });

  it('routes through a supplied transaction client instead of the cached one', async () => {
    const txDelegate = { findFirst: vi.fn().mockResolvedValue({ id: 'ci-tx', kindKey: 'vitals' }) };

    const found = await repo.findLatestByKindKey('consultation-1', 'vitals', { contextItem: txDelegate });

    expect(txDelegate.findFirst).toHaveBeenCalledTimes(1);
    expect(delegate.findFirst).not.toHaveBeenCalled();
    expect(found).toEqual({ id: 'ci-tx', kindKey: 'vitals', mapped: true });
  });
});
