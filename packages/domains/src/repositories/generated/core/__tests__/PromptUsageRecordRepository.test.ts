/**
 * PromptUsageRecordRepository — TASK-328 A4 usage-analytics aggregations.
 *
 * Department and doctor counts use Prisma `groupBy` (the
 * `TranscriptionJobRepository.countByStatus` precedent). Per-day buckets are
 * derived from a `createdAt` projection because Prisma `groupBy` cannot
 * `date_trunc` a DateTime column to a day without raw SQL — the bucketing is
 * therefore encapsulated in the repository so the service stays thin.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptUsageRecordRepository } from '../PromptUsageRecordRepository';

describe('PromptUsageRecordRepository — usage analytics (TASK-328 A4)', () => {
  let groupBy: ReturnType<typeof vi.fn>;
  let findMany: ReturnType<typeof vi.fn>;
  let repo: PromptUsageRecordRepository;

  beforeEach(() => {
    groupBy = vi.fn();
    findMany = vi.fn();
    const delegate = { groupBy, findMany };
    const unitOfWork = { getDatabaseService: () => ({ promptUsageRecord: delegate }) };
    repo = new PromptUsageRecordRepository(unitOfWork as never);
  });

  describe('groupByDepartment', () => {
    it('runs a tenant-scoped groupBy and normalizes the count shape', async () => {
      groupBy.mockResolvedValue([
        { departmentId: 'dept-1', _count: { _all: 4 } },
        { departmentId: null, _count: { _all: 1 } },
      ]);

      const result = await repo.groupByDepartment('tenant-1');

      expect(groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ by: ['departmentId'], where: { tenantId: 'tenant-1' } }),
      );
      expect(result).toEqual([
        { departmentId: 'dept-1', count: 4 },
        { departmentId: null, count: 1 },
      ]);
    });

    it('narrows by promptTemplateId when supplied', async () => {
      groupBy.mockResolvedValue([]);

      await repo.groupByDepartment('tenant-1', 'tpl-9');

      expect(groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 'tenant-1', promptTemplateId: 'tpl-9' } }),
      );
    });
  });

  describe('groupByDoctor', () => {
    it('runs a tenant-scoped groupBy on doctorId', async () => {
      groupBy.mockResolvedValue([{ doctorId: 'doc-1', _count: { _all: 5 } }]);

      const result = await repo.groupByDoctor('tenant-1');

      expect(groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ by: ['doctorId'], where: { tenantId: 'tenant-1' } }),
      );
      expect(result).toEqual([{ doctorId: 'doc-1', count: 5 }]);
    });
  });

  describe('groupByDay', () => {
    it('buckets createdAt timestamps into UTC day counts, sorted ascending', async () => {
      findMany.mockResolvedValue([
        { createdAt: new Date('2026-06-01T01:00:00.000Z') },
        { createdAt: new Date('2026-06-01T22:00:00.000Z') },
        { createdAt: new Date('2026-06-02T00:30:00.000Z') },
      ]);

      const result = await repo.groupByDay('tenant-1');

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 'tenant-1' }, select: { createdAt: true } }),
      );
      expect(result).toEqual([
        { day: '2026-06-01', count: 2 },
        { day: '2026-06-02', count: 1 },
      ]);
    });

    it('narrows by promptTemplateId when supplied', async () => {
      findMany.mockResolvedValue([]);

      await repo.groupByDay('tenant-1', 'tpl-9');

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 'tenant-1', promptTemplateId: 'tpl-9' } }),
      );
    });
  });
});
