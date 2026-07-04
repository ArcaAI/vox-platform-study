/**
 * TASK-413 — ConsultationRepository.findCreatedInRange.
 *
 * Moves the TASK-386 (#20 / E4) date-range aggregation read out of
 * `ConsultationService` (which accessed `databaseService.client` directly,
 * violating the TASK-311 AC-8 layering rule) into the repository. The query
 * semantics are pinned verbatim:
 *
 *   • where: `createdAt` between [rangeStart, rangeEnd] (inclusive)
 *   • tenantId filter ONLY when a truthy tenantId is supplied (SUPER_ADMIN
 *     with no working tenant reads cross-tenant — TASK-386 TD3)
 *   • minimal projection `{ createdAt, parentConsultationId }` — rows are
 *     returned raw (no entity mapping; the service buckets them itself)
 *
 * The base `Repository.db` getter returns `unitOfWork.getDatabaseService()[modelName]`,
 * so we hand the repo a fake unit-of-work whose `consultation` delegate is a
 * `vi.fn()` and assert the Prisma call shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../mappers', () => ({
  ConsultationEntityMapper: {
    getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }),
  },
}));

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeUow = (delegateByModel: Record<string, any>) => ({ getDatabaseService: () => delegateByModel });

describe('ConsultationRepository.findCreatedInRange (TASK-413)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let delegate: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let repo: any;

  const rangeStart = new Date('2026-01-01T00:00:00.000Z');
  const rangeEnd = new Date('2026-01-03T23:59:59.999Z');

  beforeEach(async () => {
    delegate = { findMany: vi.fn() };
    const { ConsultationRepository } = await import('../ConsultationRepository');
    repo = new ConsultationRepository(makeUow({ consultation: delegate }) as never);
  });

  it('queries createdAt within the range, tenant-scoped, with the minimal projection', async () => {
    const rows = [
      { createdAt: new Date('2026-01-01T08:00:00Z'), parentConsultationId: null },
      { createdAt: new Date('2026-01-02T09:00:00Z'), parentConsultationId: 'parent-1' },
    ];
    delegate.findMany.mockResolvedValue(rows);

    const result = await repo.findCreatedInRange(rangeStart, rangeEnd, 'tenant-1');

    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { createdAt: { gte: rangeStart, lte: rangeEnd }, tenantId: 'tenant-1' },
      select: { createdAt: true, parentConsultationId: true },
    });
    // Rows come back raw — no entity mapping (projection has only 2 columns).
    expect(result).toBe(rows);
  });

  it('omits the tenantId filter when no tenantId is given (cross-tenant super-admin read)', async () => {
    delegate.findMany.mockResolvedValue([]);

    await repo.findCreatedInRange(rangeStart, rangeEnd, null);

    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { createdAt: { gte: rangeStart, lte: rangeEnd } },
      select: { createdAt: true, parentConsultationId: true },
    });
  });

  it('propagates delegate errors (no swallow — mirrors the pre-TASK-413 service behaviour)', async () => {
    delegate.findMany.mockRejectedValue(new Error('boom'));

    await expect(repo.findCreatedInRange(rangeStart, rangeEnd, 'tenant-1')).rejects.toThrow('boom');
  });
});
