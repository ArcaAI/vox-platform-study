/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OptimisticConcurrencyException, DataNotFoundException } from '@arcaai/exceptions';

// Break the cyclic import that goes:
//   ../repository → ../common (barrel) → ./databaseServices → ./core → CoreDatabaseModule → repositories/generated/*.ts → ../common (cycle).
// The concrete repositories don't matter for these tests; we exercise the
// abstract Repository class directly.
vi.mock('../databaseServices/core/core.database.module', () => ({
  CoreDatabaseModule: class {},
}));

import { BaseEntity } from '../baseEntity/base.entity';

class TestEntity extends BaseEntity {
  validate(): void {
    /* no-op */
  }
}

const buildHarness = async () => {
  const { Repository } = await import('../repository');

  const db: any = {
    name: 'TestModel',
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  };
  const uow: any = { getDatabaseService: () => ({ TestModel: db }) };
  const mapper: any = {
    toPersistence: vi.fn(),
    toPersistenceChanges: vi.fn((e: any) => e.changes ?? {}),
    toDomainEntity: vi.fn((m: any) => ({ id: m.id, version: m.version, ...m })),
  };

  class TestRepository extends Repository<TestEntity, any> {
    constructor() {
      super(uow, 'TestModel', mapper);
    }
  }

  return { repo: new TestRepository(), db, mapper };
};

describe('Repository.updateWithVersion', () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  beforeEach(async () => {
    harness = await buildHarness();
  });

  it('issues updateMany with the version predicate, then re-reads', async () => {
    harness.db.updateMany.mockResolvedValueOnce({ count: 1 });
    harness.db.findUnique.mockResolvedValueOnce({ id: 'e-1', version: 8 });

    await harness.repo.updateWithVersion('e-1', { changes: { value: 'new' } } as any, 7);

    expect(harness.db.updateMany).toHaveBeenCalledWith({
      where: { id: 'e-1', version: 7 },
      data: { value: 'new', version: { increment: 1 } },
    });
  });

  it('throws OptimisticConcurrencyException when count === 0 and row exists', async () => {
    harness.db.updateMany.mockResolvedValueOnce({ count: 0 });
    harness.db.findUnique.mockResolvedValueOnce({ id: 'e-1', version: 9 });

    await expect(harness.repo.updateWithVersion('e-1', { changes: { value: 'new' } } as any, 7)).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
  });

  it('throws DataNotFoundException when count === 0 and row is gone', async () => {
    harness.db.updateMany.mockResolvedValueOnce({ count: 0 });
    harness.db.findUnique.mockResolvedValueOnce(null);

    await expect(harness.repo.updateWithVersion('e-1', { changes: { value: 'new' } } as any, 7)).rejects.toBeInstanceOf(DataNotFoundException);
  });

  it('strips `version` from changes payload even if present (defense in depth)', async () => {
    harness.db.updateMany.mockResolvedValueOnce({ count: 1 });
    harness.db.findUnique.mockResolvedValueOnce({ id: 'e-1', version: 8 });

    await harness.repo.updateWithVersion('e-1', { changes: { value: 'new', version: 999 } } as any, 7);

    expect(harness.db.updateMany).toHaveBeenCalledWith({
      where: { id: 'e-1', version: 7 },
      data: { value: 'new', version: { increment: 1 } },
    });
  });

  it('populates OptimisticConcurrencyException metadata with currentVersion from re-read', async () => {
    harness.db.updateMany.mockResolvedValueOnce({ count: 0 });
    harness.db.findUnique.mockResolvedValueOnce({ id: 'e-1', version: 12 });

    try {
      await harness.repo.updateWithVersion('e-1', { changes: { value: 'new' } } as any, 7);
      throw new Error('Should have thrown OptimisticConcurrencyException');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(OptimisticConcurrencyException);
      expect((err as OptimisticConcurrencyException).metadata).toEqual({
        expectedVersion: 7,
        currentVersion: 12,
      });
    }
  });
});
