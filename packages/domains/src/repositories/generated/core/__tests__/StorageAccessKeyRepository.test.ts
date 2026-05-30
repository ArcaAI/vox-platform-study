import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { StorageAccessKeyRepository } from '../StorageAccessKeyRepository';
import { ResourceStatusType } from '../../../../enums';

function makeRepo(): StorageAccessKeyRepository {
  // The base Repository constructor only calls `getDatabaseService()`; every
  // query path under test is intercepted via a `findAll` spy, so a bare stub
  // is enough to construct the repository without a real database.
  const unitOfWork = { getDatabaseService: () => ({}) } as unknown as never;
  return new StorageAccessKeyRepository(unitOfWork);
}

describe('StorageAccessKeyRepository.findActiveByTenant (F-15)', () => {
  it('pushes the expiry predicate into a single findAll query', async () => {
    const repo = makeRepo();
    const findAllSpy = vi.spyOn(repo, 'findAll').mockResolvedValue([] as never);

    await repo.findActiveByTenant('tenant-1');

    expect(findAllSpy).toHaveBeenCalledTimes(1);
    const props = findAllSpy.mock.calls[0][0] as { filters?: Record<string, unknown> };
    expect(props.filters).toBeDefined();

    const filters = props.filters as Record<string, unknown>;
    expect(filters.tenantId).toBe('tenant-1');
    expect(filters.resourceStatus).toBe(ResourceStatusType.ENABLED);

    // The expiry predicate must be expressed in the query itself as
    // (expiresAt IS NULL) OR (expiresAt > now()).
    const or = filters.OR as Array<Record<string, unknown>>;
    expect(Array.isArray(or)).toBe(true);
    expect(or).toHaveLength(2);

    const nullBranch = or.find((c) => c.expiresAt === null);
    expect(nullBranch).toBeDefined();

    const gtBranch = or.find(
      (c) => c.expiresAt !== null && typeof c.expiresAt === 'object' && c.expiresAt !== undefined && 'gt' in (c.expiresAt as object),
    );
    expect(gtBranch).toBeDefined();
    expect((gtBranch!.expiresAt as { gt: unknown }).gt).toBeInstanceOf(Date);
  });

  it('returns the query result verbatim without re-filtering expired keys in memory', async () => {
    const repo = makeRepo();
    // An entity-like object the OLD in-memory `.filter(k => !k.isExpired)` would
    // have dropped. With the predicate pushed to SQL, the repository trusts the
    // DB to have applied the filter and must return the row verbatim.
    const stillReturned = { id: 'k1', isExpired: true };
    vi.spyOn(repo, 'findAll').mockResolvedValue([stillReturned] as never);

    const result = await repo.findActiveByTenant('tenant-1');

    expect(result).toEqual([stillReturned]);
  });
});
