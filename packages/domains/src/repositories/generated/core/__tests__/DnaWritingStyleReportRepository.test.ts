/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../common/unitsOfWork/core', () => ({
  CoreUnitOfWorkService: vi.fn(),
}));
// Identity mapper so `findPaginated`'s `toDomainEntity(model)` returns the row
// unchanged (the existing method-existence tests don't exercise it).
vi.mock('../../../mappers', () => ({
  DnaWritingStyleReportEntityMapper: { getInstance: vi.fn(() => ({ toDomainEntity: (model: unknown) => model })) },
}));

describe('DnaWritingStyleReportRepository', () => {
  it('should be defined', async () => {
    const { DnaWritingStyleReportRepository } = await import('../DnaWritingStyleReportRepository');
    expect(DnaWritingStyleReportRepository).toBeDefined();
  });

  it('should have custom query methods', async () => {
    const { DnaWritingStyleReportRepository } = await import('../DnaWritingStyleReportRepository');
    const proto = DnaWritingStyleReportRepository.prototype;
    expect(typeof proto.findLatestForDoctor).toBe('function');
    expect(typeof proto.findByDepartment).toBe('function');
    expect(typeof proto.findAllForDoctor).toBe('function');
  });

  it('should inherit base Repository methods', async () => {
    const { DnaWritingStyleReportRepository } = await import('../DnaWritingStyleReportRepository');
    const proto = DnaWritingStyleReportRepository.prototype;
    expect(typeof proto.findById).toBe('function');
    expect(typeof proto.findAll).toBe('function');
    expect(typeof proto.findFirst).toBe('function');
    expect(typeof proto.create).toBe('function');
    expect(typeof proto.update).toBe('function');
    expect(typeof proto.softDelete).toBe('function');
    expect(typeof proto.count).toBe('function');
  });
});

// TASK-331 doc-02 F6 — repository-level pagination for the admin list, mirroring
// `PromptTemplateRepository.findPaginated` (`db.findMany` + `db.count`).
describe('DnaWritingStyleReportRepository — findPaginated (TASK-331 doc-02 F6)', () => {
  let findMany: ReturnType<typeof vi.fn>;
  let count: ReturnType<typeof vi.fn>;
  let repo: any;

  beforeEach(async () => {
    findMany = vi.fn();
    count = vi.fn();
    const delegate = { findMany, count };
    const unitOfWork = { getDatabaseService: () => ({ dnaWritingStyleReport: delegate }) };
    const { DnaWritingStyleReportRepository } = await import('../DnaWritingStyleReportRepository');
    repo = new DnaWritingStyleReportRepository(unitOfWork as never);
  });

  it('passes skip/take derived from page+limit, orders by createdAt desc, and returns mapped data + count', async () => {
    findMany.mockResolvedValue([
      { id: 'r1', tenantId: 'tenant-1', doctorId: 'd1' },
      { id: 'r2', tenantId: 'tenant-1', doctorId: 'd2' },
    ]);
    count.mockResolvedValue(7);

    const where = { tenantId: 'tenant-1' };
    const result = await repo.findPaginated(where, 2, 2);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where, orderBy: [{ createdAt: 'desc' }], skip: 2, take: 2 }),
    );
    expect(count).toHaveBeenCalledWith({ where });
    expect(result.count).toBe(7);
    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe('r1');
  });

  it('uses skip=0 for the first page', async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    await repo.findPaginated({ tenantId: 'tenant-1' }, 1, 50);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 50 }));
  });
});
