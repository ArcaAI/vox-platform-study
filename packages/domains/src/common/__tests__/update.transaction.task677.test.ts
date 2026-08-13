/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `Repository.update` accepts an optional transaction client.
 *
 * `create`, `createMany` and `updateWithVersion` already do; `update` did not,
 * which is what made a create-**or**-update write sequence impossible to wrap.
 *
 * Two properties are load-bearing here and each has its own test:
 *
 * 1. **Additive.** `update(id, entity)` — no third argument — must behave
 *    EXACTLY as before, through the cached extended client. Every existing
 *    call site in the monorepo passes two arguments.
 * 2. **OCC is untouched.** `updateWithVersion` already had `tx`; this change
 *    does not modify it. The drift → `OptimisticConcurrencyException` contract
 *    is re-asserted here inside AND outside a transaction so that any future
 *    edit to the shared `update`/CAS neighbourhood that damages it fails here.
 *
 * The CLS propagation in `CoreUnitOfWorkService.runInTransaction` cannot
 * substitute for the parameter: `Repository` resolves and CACHES its database
 * context in its constructor, and repositories are boot-time singletons, so an
 * already-constructed repository never observes the CLS tx client.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';

// Same cycle break as `updateWithVersion.test.ts`:
//   ../repository → ../common (barrel) → ./databaseServices → ./core →
//   CoreDatabaseModule → repositories/generated/*.ts → ../common (cycle).
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

  /** The delegate reached through the cached extended client (`this.db`). */
  const db: any = {
    name: 'TestModel',
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
  };
  /** The delegate reached through an interactive `$transaction` client. */
  const txDelegate: any = {
    name: 'TestModel',
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
  };
  const tx: any = { TestModel: txDelegate };

  const uow: any = { getDatabaseService: () => ({ TestModel: db }) };
  const mapper: any = {
    toPersistence: vi.fn(),
    toPersistenceChanges: vi.fn((e: any) => e.changes ?? {}),
    toDomainEntity: vi.fn((m: any) => ({ ...m })),
  };

  class TestRepository extends Repository<TestEntity, any> {
    constructor() {
      super(uow, 'TestModel', mapper);
    }
  }

  return { repo: new TestRepository(), db, tx, txDelegate, mapper };
};

describe('Repository.update(id, entity, tx?)', () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  beforeEach(async () => {
    harness = await buildHarness();
  });

  // =========================================================================
  // Backward compatibility: the two-argument form is unchanged
  // =========================================================================

  it('without `tx`, writes through the cached extended client — behaviour unchanged', async () => {
    harness.db.update.mockResolvedValueOnce({ id: 'e-1', value: 'new' });

    const result = await harness.repo.update('e-1', { changes: { value: 'new' } } as any);

    expect(harness.db.update).toHaveBeenCalledWith({
      where: { id: 'e-1' },
      data: { value: 'new' },
      include: undefined,
    });
    expect(harness.txDelegate.update).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'e-1', value: 'new' });
  });

  it('without `tx`, still persists ONLY the tracked changes', async () => {
    harness.db.update.mockResolvedValueOnce({ id: 'e-1' });

    await harness.repo.update('e-1', { changes: { a: 1 }, untracked: 'ignored' } as any);

    expect(harness.db.update.mock.calls[0][0].data).toEqual({ a: 1 });
  });

  // =========================================================================
  // The new behaviour: the write joins the caller's transaction
  // =========================================================================

  it('with `tx`, writes through the transaction client and NEVER through the cached client', async () => {
    harness.txDelegate.update.mockResolvedValueOnce({ id: 'e-1', value: 'new' });

    const result = await harness.repo.update('e-1', { changes: { value: 'new' } } as any, harness.tx);

    expect(harness.txDelegate.update).toHaveBeenCalledWith({
      where: { id: 'e-1' },
      data: { value: 'new' },
      include: undefined,
    });
    // The whole point: nothing escapes the transaction, so a rollback covers it.
    expect(harness.db.update).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'e-1', value: 'new' });
  });

  it('with `tx`, a rejecting write propagates so the caller’s $transaction rolls back', async () => {
    harness.txDelegate.update.mockRejectedValueOnce(new Error('constraint violation'));

    await expect(harness.repo.update('e-1', { changes: { value: 'new' } } as any, harness.tx)).rejects.toThrow('constraint violation');
  });

  it('resolves the delegate by model name off the tx client — the same shape `create` uses', async () => {
    harness.txDelegate.update.mockResolvedValueOnce({ id: 'e-1' });

    await harness.repo.update('e-1', { changes: { a: 1 } } as any, harness.tx);

    // `tx.TestModel`, not `tx` itself — a tx client is a client, not a delegate.
    expect(harness.txDelegate.update).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // Why the parameter is NECESSARY — the CLS route cannot work
  // =========================================================================

  it('a constructed repository NEVER observes a later CLS tx client — so `tx` cannot be implicit', async () => {
    const { Repository } = await import('../repository');

    const cachedDelegate: any = { name: 'TestModel', update: vi.fn().mockResolvedValue({ id: 'e-1' }) };
    const clsDelegate: any = { name: 'TestModel', update: vi.fn().mockResolvedValue({ id: 'e-1' }) };

    // Mimics `CoreUnitOfWorkService.getDatabaseService()`: it returns the CLS
    // transaction client while `runInTransaction` is in flight, and the
    // extended client otherwise.
    let inFlight = false;
    const uow: any = { getDatabaseService: () => (inFlight ? { TestModel: clsDelegate } : { TestModel: cachedDelegate }) };
    const mapper: any = {
      toPersistence: vi.fn(),
      toPersistenceChanges: vi.fn((e: any) => e.changes ?? {}),
      toDomainEntity: vi.fn((m: any) => ({ ...m })),
    };
    class TestRepository extends Repository<TestEntity, any> {
      constructor() {
        super(uow, 'TestModel', mapper);
      }
    }

    // Constructed at boot, before any transaction — like every NestJS
    // singleton repository. `_databaseContext` is resolved and CACHED here.
    const repo = new TestRepository();

    // Now a transaction opens and publishes its client on CLS.
    inFlight = true;
    await repo.update('e-1', { changes: { a: 1 } } as any);

    // The write went to the CACHED client — it escaped the transaction. This
    // is why `runInTransaction`'s CLS propagation is not a substitute for the
    // explicit parameter, and why any call site that omits `tx` while
    // believing "the repository joins the tx via the shared context" is
    // silently writing outside it.
    expect(cachedDelegate.update).toHaveBeenCalledTimes(1);
    expect(clsDelegate.update).not.toHaveBeenCalled();

    // …and passing `tx` explicitly is what actually enrols the write.
    await repo.update('e-1', { changes: { a: 1 } } as any, { TestModel: clsDelegate });
    expect(clsDelegate.update).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // OCC semantics are NOT changed
  // =========================================================================

  describe('updateWithVersion — OCC unchanged', () => {
    it('throws OptimisticConcurrencyException on drift OUTSIDE a transaction', async () => {
      harness.db.updateMany.mockResolvedValueOnce({ count: 0 });
      harness.db.findUnique.mockResolvedValueOnce({ id: 'e-1', version: 9 });

      await expect(harness.repo.updateWithVersion('e-1', { changes: { value: 'new' } } as any, 7)).rejects.toBeInstanceOf(
        OptimisticConcurrencyException,
      );
    });

    it('throws OptimisticConcurrencyException on drift INSIDE a transaction', async () => {
      harness.txDelegate.updateMany.mockResolvedValueOnce({ count: 0 });
      harness.txDelegate.findUnique.mockResolvedValueOnce({ id: 'e-1', version: 9 });

      await expect(harness.repo.updateWithVersion('e-1', { changes: { value: 'new' } } as any, 7, harness.tx)).rejects.toBeInstanceOf(
        OptimisticConcurrencyException,
      );
      // The CAS predicate and the disambiguating re-read both stayed inside.
      expect(harness.db.updateMany).not.toHaveBeenCalled();
      expect(harness.db.findUnique).not.toHaveBeenCalled();
    });

    it('still issues the compare-and-set predicate with the version increment, in both contexts', async () => {
      harness.db.updateMany.mockResolvedValueOnce({ count: 1 });
      harness.db.findUnique.mockResolvedValueOnce({ id: 'e-1', version: 8 });
      await harness.repo.updateWithVersion('e-1', { changes: { value: 'a' } } as any, 7);

      harness.txDelegate.updateMany.mockResolvedValueOnce({ count: 1 });
      harness.txDelegate.findUnique.mockResolvedValueOnce({ id: 'e-1', version: 8 });
      await harness.repo.updateWithVersion('e-1', { changes: { value: 'a' } } as any, 7, harness.tx);

      const expected = { where: { id: 'e-1', version: 7 }, data: { value: 'a', version: { increment: 1 } } };
      expect(harness.db.updateMany).toHaveBeenCalledWith(expected);
      expect(harness.txDelegate.updateMany).toHaveBeenCalledWith(expected);
    });

    it('`update` does NOT acquire OCC semantics — no version predicate, no increment', async () => {
      harness.txDelegate.update.mockResolvedValueOnce({ id: 'e-1' });

      await harness.repo.update('e-1', { changes: { value: 'new' } } as any, harness.tx);

      const call = harness.txDelegate.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'e-1' });
      expect(call.data).not.toHaveProperty('version');
      expect(harness.txDelegate.updateMany).not.toHaveBeenCalled();
    });
  });
});
