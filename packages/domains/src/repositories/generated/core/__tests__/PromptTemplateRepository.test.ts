/**
 * PromptTemplateRepository — repository-level pagination.
 *
 * `findPaginated` resolves the page slice and the total matching count in one
 * call (`db.findMany` + `db.count` against the same extended client), so the
 * controller no longer materializes the whole tenant result set to slice it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptTemplateRepository } from '../PromptTemplateRepository';

describe('PromptTemplateRepository — findPaginated', () => {
  let findMany: ReturnType<typeof vi.fn>;
  let count: ReturnType<typeof vi.fn>;
  let repo: PromptTemplateRepository;

  beforeEach(() => {
    findMany = vi.fn();
    count = vi.fn();
    const delegate = { findMany, count };
    const unitOfWork = { getDatabaseService: () => ({ promptTemplate: delegate }) };
    repo = new PromptTemplateRepository(unitOfWork as never);
  });

  it('passes skip/take derived from page+limit and returns mapped data + count', async () => {
    findMany.mockResolvedValue([
      { id: 't1', tenantId: 'tenant-1', name: 'A', category: 'SYSTEM' },
      { id: 't2', tenantId: 'tenant-1', name: 'B', category: 'SYSTEM' },
    ]);
    count.mockResolvedValue(7);

    const where = { tenantId: 'tenant-1' };
    const result = await repo.findPaginated(where, 2, 2);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 2, take: 2 }));
    expect(count).toHaveBeenCalledWith({ where });
    expect(result.count).toBe(7);
    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe('t1');
  });

  it('uses skip=0 for the first page', async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    await repo.findPaginated({ tenantId: 'tenant-1' }, 1, 50);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 50 }));
  });
});
