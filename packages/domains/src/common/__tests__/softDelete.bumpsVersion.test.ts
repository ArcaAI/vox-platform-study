/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Repository.softDelete / restore — `_version` bump.
 *
 * Soft-delete is a real state change; without bumping `_version` an admin who
 * read at v7 could `updateWithVersion(…, 7)` after another admin soft-deleted
 * the row, succeed, and resurrect deleted PHI — a compliance / SOC2 finding.
 *
 * Soft-delete / restore bump `_version` on every write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResourceStatusType } from '../../enums/generated/ResourceStatusType';

// Break the cyclic import that goes:
//   ../repository → ../common (barrel) → ./databaseServices → ./core →
//   CoreDatabaseModule → repositories/generated/*.ts → ../common (cycle).
// Mirrors the workaround used by `updateWithVersion.test.ts`.
vi.mock('../databaseServices/core/core.database.module', () => ({
  CoreDatabaseModule: class {},
}));

// `repository.ts` calls `modelHasSoftDelete(this._modelName)` at runtime; the
// shared fixture uses a synthetic `TestModel` that isn't in the real Prisma
// schema. Force the predicate to true so soft-delete / restore proceed.
vi.mock('@arcaai/database', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@arcaai/database');
  return {
    ...actual,
    modelHasSoftDelete: () => true,
  };
});

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
  };
  const uow: any = { getDatabaseService: () => ({ TestModel: db }) };
  const mapper: any = {
    toPersistence: vi.fn(),
    toPersistenceChanges: vi.fn(),
    toDomainEntity: vi.fn((m: any) => ({ id: m.id, version: m.version, ...m })),
  };

  class TestRepository extends Repository<TestEntity, any> {
    constructor() {
      super(uow, 'TestModel', mapper);
    }
  }

  return { repo: new TestRepository(), db, mapper };
};

describe('Repository.softDelete bumps _version (Stream D Phase B)', () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  it('softDelete includes version: { increment: 1 } in the data payload', async () => {
    harness.db.update.mockResolvedValueOnce({ id: 'e-1', version: 2 });

    await harness.repo.softDelete('e-1', 'u-1');

    expect(harness.db.update).toHaveBeenCalledTimes(1);
    expect(harness.db.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'e-1' },
        data: expect.objectContaining({
          resourceStatus: ResourceStatusType.DELETED,
          resourceStatusUpdatedBy: 'u-1',
          version: { increment: 1 },
        }),
      }),
    );
  });

  it('restore includes version: { increment: 1 } in the data payload', async () => {
    harness.db.update.mockResolvedValueOnce({ id: 'e-1', version: 3 });

    await harness.repo.restore('e-1', 'u-1');

    expect(harness.db.update).toHaveBeenCalledTimes(1);
    expect(harness.db.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'e-1' },
        data: expect.objectContaining({
          resourceStatus: ResourceStatusType.ENABLED,
          resourceStatusUpdatedBy: 'u-1',
          version: { increment: 1 },
        }),
      }),
    );
  });

  it('softDelete without explicit updatedBy still bumps version', async () => {
    harness.db.update.mockResolvedValueOnce({ id: 'e-1', version: 5 });

    await harness.repo.softDelete('e-1');

    const call = harness.db.update.mock.calls[0]?.[0];
    expect(call?.data?.version).toEqual({ increment: 1 });
    expect(call?.data?.resourceStatus).toBe(ResourceStatusType.DELETED);
    // No updatedBy in data because none was passed.
    expect(call?.data?.resourceStatusUpdatedBy).toBeUndefined();
  });
});
