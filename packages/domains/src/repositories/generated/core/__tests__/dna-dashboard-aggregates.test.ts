/**
 * TASK-328 A5 — Behavioural tests for the DNA dashboard aggregate repo methods.
 *
 * The base `Repository.db` getter returns `unitOfWork.getDatabaseService()[modelName]`,
 * so we hand each repository a fake unit-of-work whose delegate is a set of
 * `vi.fn()`s and assert the Prisma calls + post-processing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceStatusType } from '../../../../enums';

// Mappers: only the two the repos touch. The usage mapper echoes the model so
// `findRecent` mapping is observable; the report mapper is unused by aggregates.
vi.mock('../../../../mappers', () => ({
  DnaUsageRecordEntityMapper: {
    getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => ({ ...m, __mapped: true }) }),
  },
  DnaWritingStyleReportEntityMapper: {
    getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }),
  },
}));

// `CoreUnitOfWorkService` is a type-only dependency of the repos; stub it so the
// module graph resolves without pulling the real DI container.
vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeUow = (delegateByModel: Record<string, any>) => ({
  getDatabaseService: () => delegateByModel,
});

describe('DnaUsageRecordRepository aggregates (TASK-328 A5)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let delegate: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let repo: any;

  beforeEach(async () => {
    delegate = { count: vi.fn(), findMany: vi.fn() };
    const { DnaUsageRecordRepository } = await import('../DnaUsageRecordRepository');
    repo = new DnaUsageRecordRepository(makeUow({ dnaUsageRecord: delegate }) as never);
  });

  it('countSince filters by createdAt>=since and tenant', async () => {
    delegate.count.mockResolvedValue(12);
    const since = new Date('2026-02-01T00:00:00.000Z');

    const result = await repo.countSince(since, 'tenant-1');

    expect(result).toBe(12);
    expect(delegate.count).toHaveBeenCalledWith({ where: { createdAt: { gte: since }, tenantId: 'tenant-1' } });
  });

  it('countSince omits the tenant filter when no tenantId is given (all tenants)', async () => {
    delegate.count.mockResolvedValue(3);
    const since = new Date('2026-02-01T00:00:00.000Z');

    await repo.countSince(since);

    expect(delegate.count).toHaveBeenCalledWith({ where: { createdAt: { gte: since } } });
  });

  it('getDailyUsageCounts buckets rows by UTC day, oldest first', async () => {
    delegate.findMany.mockResolvedValue([
      { createdAt: new Date('2026-02-17T23:30:00.000Z') },
      { createdAt: new Date('2026-02-18T01:00:00.000Z') },
      { createdAt: new Date('2026-02-18T09:00:00.000Z') },
    ]);

    const result = await repo.getDailyUsageCounts(new Date('2026-02-01T00:00:00.000Z'), 'tenant-1');

    expect(result).toEqual([
      { date: '2026-02-17', count: 1 },
      { date: '2026-02-18', count: 2 },
    ]);
    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { createdAt: { gte: expect.any(Date) }, tenantId: 'tenant-1' },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('getDailyUsageCounts returns an empty array when there is no activity', async () => {
    delegate.findMany.mockResolvedValue([]);

    const result = await repo.getDailyUsageCounts(new Date('2026-02-01T00:00:00.000Z'));

    expect(result).toEqual([]);
  });

  it('findRecent requests the newest `limit` rows for the tenant and maps them', async () => {
    delegate.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);

    const result = await repo.findRecent(2, 'tenant-1');

    expect(result).toEqual([
      { id: 'u1', __mapped: true },
      { id: 'u2', __mapped: true },
    ]);
    expect(delegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        where: { tenantId: 'tenant-1' },
        orderBy: [{ createdAt: 'desc' }],
      }),
    );
  });
});

describe('DnaWritingStyleReportRepository aggregates (TASK-328 A5)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let delegate: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let repo: any;

  beforeEach(async () => {
    delegate = { groupBy: vi.fn(), aggregate: vi.fn() };
    const { DnaWritingStyleReportRepository } = await import('../DnaWritingStyleReportRepository');
    repo = new DnaWritingStyleReportRepository(makeUow({ dnaWritingStyleReport: delegate }) as never);
  });

  it('countDoctorsWithLatestReport returns the number of distinct doctor groups', async () => {
    delegate.groupBy.mockResolvedValue([{ doctorId: 'd1' }, { doctorId: 'd2' }, { doctorId: 'd3' }]);

    const result = await repo.countDoctorsWithLatestReport('tenant-1');

    expect(result).toBe(3);
    expect(delegate.groupBy).toHaveBeenCalledWith({
      by: ['doctorId'],
      where: { isLatest: true, resourceStatus: ResourceStatusType.ENABLED, tenantId: 'tenant-1' },
    });
  });

  it('countDoctorsWithLatestReport spans all tenants when tenantId is omitted', async () => {
    delegate.groupBy.mockResolvedValue([{ doctorId: 'd1' }]);

    await repo.countDoctorsWithLatestReport();

    expect(delegate.groupBy).toHaveBeenCalledWith({
      by: ['doctorId'],
      where: { isLatest: true, resourceStatus: ResourceStatusType.ENABLED },
    });
  });

  it('averageCurrentVersion returns the Prisma _avg', async () => {
    delegate.aggregate.mockResolvedValue({ _avg: { currentVersionNumber: 2.5 } });

    const result = await repo.averageCurrentVersion('tenant-1');

    expect(result).toBe(2.5);
    expect(delegate.aggregate).toHaveBeenCalledWith({
      where: { isLatest: true, resourceStatus: ResourceStatusType.ENABLED, tenantId: 'tenant-1' },
      _avg: { currentVersionNumber: true },
    });
  });

  it('averageCurrentVersion falls back to 0 when there are no rows (_avg is null)', async () => {
    delegate.aggregate.mockResolvedValue({ _avg: { currentVersionNumber: null } });

    const result = await repo.averageCurrentVersion('tenant-1');

    expect(result).toBe(0);
  });
});
