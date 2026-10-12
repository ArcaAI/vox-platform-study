/**
 * The two batch reads a consultation LIST answer is decorated with: every encounter of a page of
 * consultations, and the newest approval of each — one query each, whatever the page size.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../mappers', () => ({
  ConsultationEncounterEntityMapper: { getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }) },
  ConsultationApprovalEntityMapper: { getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }) },
}));

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const makeUow = (delegateByModel: Record<string, any>) => ({ getDatabaseService: () => delegateByModel });

describe('ConsultationEncounterRepository.findByConsultations', () => {
  let delegate: any;
  let repo: any;

  beforeEach(async () => {
    delegate = { findMany: vi.fn().mockResolvedValue([]) };
    const { ConsultationEncounterRepository } = await import('../ConsultationEncounterRepository');
    repo = new ConsultationEncounterRepository(makeUow({ consultationEncounter: delegate }) as never);
  });

  it('reads every encounter of the given consultations in ONE query, in seq order', async () => {
    delegate.findMany.mockResolvedValue([
      { id: 'e-a-1', consultationId: 'a', seq: 1 },
      { id: 'e-b-1', consultationId: 'b', seq: 1 },
    ]);

    await expect(repo.findByConsultations(['a', 'b', 'a'])).resolves.toEqual([
      { id: 'e-a-1', consultationId: 'a', seq: 1 },
      { id: 'e-b-1', consultationId: 'b', seq: 1 },
    ]);
    expect(delegate.findMany).toHaveBeenCalledTimes(1);
    const [args] = delegate.findMany.mock.calls[0];
    expect(args.where).toEqual({ consultationId: { in: ['a', 'b'] } });
    expect(args.orderBy).toEqual([{ consultationId: 'asc' }, { seq: 'asc' }]);
  });

  it('queries nothing for an empty page', async () => {
    await expect(repo.findByConsultations([])).resolves.toEqual([]);
    expect(delegate.findMany).not.toHaveBeenCalled();
  });
});

describe('ConsultationApprovalRepository.findLatestByConsultations', () => {
  let delegate: any;
  let repo: any;

  beforeEach(async () => {
    delegate = { findMany: vi.fn().mockResolvedValue([]) };
    const { ConsultationApprovalRepository } = await import('../ConsultationApprovalRepository');
    repo = new ConsultationApprovalRepository(makeUow({ consultationApproval: delegate }) as never);
  });

  it('answers the NEWEST approval per consultation from ONE query', async () => {
    delegate.findMany.mockResolvedValue([
      { id: 'ap-a-2', consultationId: 'a', approvedAt: new Date('2026-10-02') },
      { id: 'ap-b-1', consultationId: 'b', approvedAt: new Date('2026-10-01') },
      { id: 'ap-a-1', consultationId: 'a', approvedAt: new Date('2026-09-30') },
    ]);

    const latest: Map<string, any> = await repo.findLatestByConsultations(['a', 'b', 'c']);

    expect(delegate.findMany).toHaveBeenCalledTimes(1);
    const [args] = delegate.findMany.mock.calls[0];
    expect(args.where).toEqual({ consultationId: { in: ['a', 'b', 'c'] } });
    expect(args.orderBy).toEqual([{ approvedAt: 'desc' }]);
    expect(latest.get('a')?.id).toBe('ap-a-2');
    expect(latest.get('b')?.id).toBe('ap-b-1');
    expect(latest.has('c')).toBe(false);
  });

  it('queries nothing for an empty set', async () => {
    await expect(repo.findLatestByConsultations([])).resolves.toEqual(new Map());
    expect(delegate.findMany).not.toHaveBeenCalled();
  });
});
