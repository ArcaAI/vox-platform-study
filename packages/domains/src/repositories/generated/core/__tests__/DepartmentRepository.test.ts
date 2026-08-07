/**
 * DepartmentRepository — deterministic ordering (TASK-634 D-05).
 *
 * `findAllByTenant` previously sorted by `name asc` ONLY. ArcaAI has two
 * departments both named "General Medicine" (one carries the tenant's
 * prompt columns + a default agent, the other carries none), so a
 * name-only sort left the tie broken by an unspecified Postgres order —
 * `matchTenantDepartment`'s "first hit wins" then non-deterministically
 * picked either row. Adding `id asc` as a secondary key makes the order
 * (and therefore which row wins the tie) stable.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DepartmentRepository } from '../DepartmentRepository';

describe('DepartmentRepository — deterministic ordering (TASK-634 D-05)', () => {
  let findMany: ReturnType<typeof vi.fn>;
  let repo: DepartmentRepository;

  beforeEach(() => {
    findMany = vi.fn().mockResolvedValue([]);
    const delegate = { findMany };
    const unitOfWork = { getDatabaseService: () => ({ department: delegate }) };
    repo = new DepartmentRepository(unitOfWork as never);
  });

  it('findAllByTenant sorts by name asc, id asc (stable tiebreak on duplicate names)', async () => {
    await repo.findAllByTenant('tenant-1');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('preserves the includeDisabled filter behavior alongside the new sort', async () => {
    await repo.findAllByTenant('tenant-1', { includeDisabled: true });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-1' }),
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    );
    const call = findMany.mock.calls[0][0];
    expect(call.where.resourceStatus).toBeUndefined();
  });
});
