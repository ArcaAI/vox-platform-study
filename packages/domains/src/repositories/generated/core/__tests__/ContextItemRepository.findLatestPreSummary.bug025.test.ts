/**
 * BUG-025 — `findLatestPreSummary` served the live note's durable snapshot (a PRE_SUMMARY row with
 * `metaData.subType = 'LIVE_SOAP_SNAPSHOT'`) as "the latest pre-summary", so a consultation with no
 * prior context showed its own live note in the Pre-summary panel after Stop. `excludeSubTypes`
 * skips such rows; without it the read is unchanged (one `findFirst`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextItemType, ResourceStatusType } from '../../../../enums';

vi.mock('../../../../mappers', () => ({
  ContextItemEntityMapper: {
    getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => ({ ...m, mapped: true }) }),
  },
}));

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const makeUow = (delegateByModel: Record<string, any>) => ({ getDatabaseService: () => delegateByModel });

const row = (id: string, subType?: string) => ({ id, metaData: subType ? { subType } : null });

describe('ContextItemRepository.findLatestPreSummary (BUG-025)', () => {
  let delegate: any;
  let repo: any;

  beforeEach(async () => {
    delegate = { findFirst: vi.fn().mockResolvedValue(row('only')), findMany: vi.fn().mockResolvedValue([]) };
    const { ContextItemRepository } = await import('../ContextItemRepository');
    repo = new ContextItemRepository(makeUow({ contextItem: delegate }) as never);
  });

  it('skips an excluded subType and returns the newest genuine pre-summary', async () => {
    delegate.findMany.mockResolvedValue([row('snapshot', 'LIVE_SOAP_SNAPSHOT'), row('case-notes'), row('older')]);

    const result = await repo.findLatestPreSummary('consultation-1', { excludeSubTypes: ['LIVE_SOAP_SNAPSHOT'] });

    expect(result).toMatchObject({ id: 'case-notes', mapped: true });
    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { consultationId: 'consultation-1', type: ContextItemType.PRE_SUMMARY, resourceStatus: ResourceStatusType.ENABLED },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns null when the only pre-summary is an excluded live snapshot', async () => {
    delegate.findMany.mockResolvedValue([row('snapshot', 'LIVE_SOAP_SNAPSHOT')]);
    expect(await repo.findLatestPreSummary('consultation-1', { excludeSubTypes: ['LIVE_SOAP_SNAPSHOT'] })).toBeNull();
  });

  it('is unchanged without the option: one findFirst, any subType', async () => {
    const result = await repo.findLatestPreSummary('consultation-1');
    expect(result).toMatchObject({ id: 'only' });
    expect(delegate.findMany).not.toHaveBeenCalled();
  });
});
