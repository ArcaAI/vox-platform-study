/** Keyset paging + tenant discovery that let the auto-close sweep serve every tenant. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsultationStatus, ResourceStatusType } from '../../../../enums';

vi.mock('../../../../mappers', () => ({
  ConsultationEntityMapper: { getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }) },
}));
vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const makeUow = (delegateByModel: Record<string, any>) => ({ getDatabaseService: () => delegateByModel });
const CLOSED = [ConsultationStatus.CLOSED_COMPLETE, ConsultationStatus.CLOSED_INCOMPLETE];

describe('ConsultationRepository auto-close sweep queries', () => {
  let delegate: any;
  let repo: any;
  const cutoff = new Date('2026-10-05T00:00:00.000Z');

  beforeEach(async () => {
    delegate = { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([{ tenantId: 'b' }, { tenantId: 'a' }]) };
    const { ConsultationRepository } = await import('../ConsultationRepository');
    repo = new ConsultationRepository(makeUow({ consultation: delegate }) as never);
  });

  it('findAutoCloseEligible resumes strictly after a (lastActivityAt, id) cursor with a stable order', async () => {
    const at = new Date('2026-10-04T00:00:00.000Z');
    await repo.findAutoCloseEligible(cutoff, { tenantId: 't', limit: 50, after: { lastActivityAt: at, id: 'x' } });
    const args = delegate.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      tenantId: 't',
      status: { notIn: CLOSED },
      lastActivityAt: { lt: cutoff },
      resourceStatus: ResourceStatusType.ENABLED,
      OR: [{ lastActivityAt: { gt: at } }, { lastActivityAt: at, id: { gt: 'x' } }],
    });
    expect(args.orderBy).toEqual([{ lastActivityAt: 'asc' }, { id: 'asc' }]);
  });

  it('findAutoCloseTenantIds lists the distinct tenants with a candidate past the floor, sorted', async () => {
    await expect(repo.findAutoCloseTenantIds(cutoff)).resolves.toEqual(['a', 'b']);
    expect(delegate.groupBy).toHaveBeenCalledWith({
      by: ['tenantId'],
      where: { status: { notIn: CLOSED }, lastActivityAt: { lt: cutoff }, resourceStatus: ResourceStatusType.ENABLED },
    });
  });
});
