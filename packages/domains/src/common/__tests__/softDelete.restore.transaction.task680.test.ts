/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TASK-680 — `Repository.softDelete` and `Repository.restore` accept an
 * optional transaction client.
 *
 * `create`, `createMany`, `updateWithVersion` and (since TASK-677) `update` all
 * do; these two did not. TASK-677 §6.2 recorded what that already cost: TASK-615
 * needed a transactional soft-delete for invoice lines, could not use the base
 * class, and hand-wrote `BillingInvoiceLineWriteRepository` — duplicating
 * OCC-sensitive logic (`resourceStatus`, `resourceStatusUpdatedAt`,
 * `version: { increment: 1 }`) outside the one place the rules say it belongs.
 *
 * The pair is fixed together on purpose: `restore` is the exact inverse of
 * `softDelete`, and fixing one alone guarantees they drift.
 *
 * Three properties are load-bearing and each has its own test:
 *
 * 1. **Additive.** The one- and two-argument forms must behave EXACTLY as
 *    before, through the cached extended client. All 43 existing non-test call
 *    sites (37 `softDelete`, 6 `restore`) pass at most two arguments and are
 *    untouched by this ticket — backward compatibility by construction, not by
 *    assertion: when `tx` is absent the delegate resolves to `this.db`, the
 *    identical expression the method used before.
 * 2. **OCC is untouched.** Neither method may acquire compare-and-set
 *    semantics. Both bump `version` in `data` — that is pre-existing, deliberate
 *    behaviour (a stale reader must not resurrect deleted PHI) and is NOT the
 *    same thing as a `_version` PREDICATE. `updateWithVersion` remains the only
 *    CAS path.
 * 3. **The write genuinely enrols in the caller's transaction**, so a rollback
 *    covers it. Pinned by a journalling harness (T-8) rather than by asserting
 *    on which mock was called, because the latter passes vacuously against a
 *    method that never writes at all.
 *
 * The CLS propagation in `CoreUnitOfWorkService.runInTransaction` cannot
 * substitute for the parameter: `Repository` resolves and CACHES its database
 * context in its constructor, and repositories are boot-time singletons, so an
 * already-constructed repository never observes the CLS tx client. That is
 * pinned by `update.transaction.task677.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Same cycle break as `update.transaction.task677.test.ts` / `updateWithVersion.test.ts`:
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

/**
 * `modelHasSoftDelete` reads the real `MODELS_WITHOUT_SOFT_DELETE` allow-list
 * from `@arcaai/database`. `TestModel` is absent from it, so it soft-deletes;
 * `ContextItemVersion` is present, so it does not. Both are real answers from
 * the real list — no mocking of the guard.
 */
const SOFT_DELETE_MODEL = 'TestModel';
const NO_SOFT_DELETE_MODEL = 'ContextItemVersion';

const buildHarness = async (modelName: string = SOFT_DELETE_MODEL) => {
  const { Repository } = await import('../repository');

  /** The delegate reached through the cached extended client (`this.db`). */
  const db: any = { name: modelName, update: vi.fn(), updateMany: vi.fn() };
  /** The delegate reached through an interactive `$transaction` client. */
  const txDelegate: any = { name: modelName, update: vi.fn(), updateMany: vi.fn() };
  const tx: any = { [modelName]: txDelegate };

  const uow: any = { getDatabaseService: () => ({ [modelName]: db }) };
  const mapper: any = {
    toPersistence: vi.fn(),
    toPersistenceChanges: vi.fn((e: any) => e.changes ?? {}),
    toDomainEntity: vi.fn((m: any) => ({ ...m })),
  };

  class TestRepository extends Repository<TestEntity, any> {
    constructor() {
      super(uow, modelName, mapper);
    }
  }

  return { repo: new TestRepository(), db, tx, txDelegate, mapper };
};

describe('TASK-680 — Repository.softDelete(id, updatedBy?, tx?) / restore(id, updatedBy?, tx?)', () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  beforeEach(async () => {
    harness = await buildHarness();
  });

  // =========================================================================
  // T-1 / T-4 — backward compatibility: the existing forms are unchanged
  // =========================================================================

  describe('without `tx` — behaviour identical to before this ticket', () => {
    it('softDelete writes DELETED through the cached extended client', async () => {
      harness.db.update.mockResolvedValueOnce({ id: 'e-1' });

      await harness.repo.softDelete('e-1', 'admin-1');

      expect(harness.db.update).toHaveBeenCalledTimes(1);
      const call = harness.db.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'e-1' });
      expect(call.data.resourceStatus).toBe('DELETED');
      expect(call.data.resourceStatusUpdatedBy).toBe('admin-1');
      expect(call.data.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      // Pre-existing, deliberate: a stale reader at v(n) must not be able to
      // `updateWithVersion(…, n)` a row another admin just soft-deleted.
      expect(call.data.version).toEqual({ increment: 1 });
      expect(harness.txDelegate.update).not.toHaveBeenCalled();
    });

    it('restore writes ENABLED through the cached extended client', async () => {
      harness.db.update.mockResolvedValueOnce({ id: 'e-1' });

      await harness.repo.restore('e-1', 'admin-1');

      const call = harness.db.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'e-1' });
      expect(call.data.resourceStatus).toBe('ENABLED');
      expect(call.data.resourceStatusUpdatedBy).toBe('admin-1');
      expect(call.data.version).toEqual({ increment: 1 });
      expect(harness.txDelegate.update).not.toHaveBeenCalled();
    });

    it('the ONE-argument form still works — the commonest call shape in the monorepo', async () => {
      harness.db.update.mockResolvedValueOnce({ id: 'e-1' });

      await harness.repo.softDelete('e-1');

      expect(harness.db.update).toHaveBeenCalledTimes(1);
      // No `updatedBy` supplied ⇒ the stamp is omitted entirely, not written null.
      expect(harness.db.update.mock.calls[0][0].data).not.toHaveProperty('resourceStatusUpdatedBy');
    });

    it('returns the mapped domain entity, not the raw model', async () => {
      harness.db.update.mockResolvedValueOnce({ id: 'e-1', resourceStatus: 'DELETED' });

      const result = await harness.repo.softDelete('e-1');

      expect(harness.mapper.toDomainEntity).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ id: 'e-1', resourceStatus: 'DELETED' });
    });
  });

  // =========================================================================
  // T-2 / T-5 — the new behaviour: the write joins the caller's transaction
  // =========================================================================

  describe('with `tx` — the write joins the transaction and never escapes it', () => {
    it('softDelete writes through the transaction client and NEVER through the cached client', async () => {
      harness.txDelegate.update.mockResolvedValueOnce({ id: 'e-1' });

      await harness.repo.softDelete('e-1', 'admin-1', harness.tx);

      expect(harness.txDelegate.update).toHaveBeenCalledTimes(1);
      const call = harness.txDelegate.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'e-1' });
      expect(call.data.resourceStatus).toBe('DELETED');
      expect(call.data.version).toEqual({ increment: 1 });
      // The whole point: nothing escapes the transaction, so a rollback covers it.
      expect(harness.db.update).not.toHaveBeenCalled();
    });

    it('restore writes through the transaction client and NEVER through the cached client', async () => {
      harness.txDelegate.update.mockResolvedValueOnce({ id: 'e-1' });

      await harness.repo.restore('e-1', 'admin-1', harness.tx);

      expect(harness.txDelegate.update).toHaveBeenCalledTimes(1);
      expect(harness.txDelegate.update.mock.calls[0][0].data.resourceStatus).toBe('ENABLED');
      expect(harness.db.update).not.toHaveBeenCalled();
    });

    // T-3 — the optional-stamp branch must survive the signature change: a
    // caller that wants a tx but has no acting user must not be forced to
    // invent one, and must not silently write `resourceStatusUpdatedBy: undefined`.
    it('omits resourceStatusUpdatedBy when `updatedBy` is undefined but `tx` IS supplied', async () => {
      harness.txDelegate.update.mockResolvedValueOnce({ id: 'e-1' });

      await harness.repo.softDelete('e-1', undefined, harness.tx);

      expect(harness.txDelegate.update).toHaveBeenCalledTimes(1);
      expect(harness.txDelegate.update.mock.calls[0][0].data).not.toHaveProperty('resourceStatusUpdatedBy');
      expect(harness.db.update).not.toHaveBeenCalled();
    });

    it('resolves the delegate by model name off the tx client — the same shape `create`/`update` use', async () => {
      harness.txDelegate.update.mockResolvedValue({ id: 'e-1' });

      await harness.repo.softDelete('e-1', 'admin-1', harness.tx);
      await harness.repo.restore('e-1', 'admin-1', harness.tx);

      // `tx.TestModel`, not `tx` itself — a tx client is a client, not a delegate.
      expect(harness.txDelegate.update).toHaveBeenCalledTimes(2);
    });

    it('a rejecting write propagates so the caller’s $transaction rolls back', async () => {
      harness.txDelegate.update.mockRejectedValueOnce(new Error('constraint violation'));

      await expect(harness.repo.softDelete('e-1', 'admin-1', harness.tx)).rejects.toThrow('constraint violation');
    });
  });

  // =========================================================================
  // T-6 — the soft-delete support guard is unchanged and still fires FIRST
  // =========================================================================

  describe('the supportsSoftDelete guard still throws before any write', () => {
    it('softDelete throws for a model without a resourceStatus column — with `tx` supplied', async () => {
      const h = await buildHarness(NO_SOFT_DELETE_MODEL);

      await expect(h.repo.softDelete('e-1', 'admin-1', h.tx)).rejects.toThrow(/softDelete is not supported/);

      // The guard fires BEFORE the delegate is resolved — supplying a tx must
      // not create a route around it.
      expect(h.txDelegate.update).not.toHaveBeenCalled();
      expect(h.db.update).not.toHaveBeenCalled();
    });

    it('restore throws for a model without a resourceStatus column — with `tx` supplied', async () => {
      const h = await buildHarness(NO_SOFT_DELETE_MODEL);

      await expect(h.repo.restore('e-1', 'admin-1', h.tx)).rejects.toThrow(/restore is not supported/);

      expect(h.txDelegate.update).not.toHaveBeenCalled();
      expect(h.db.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // T-7 — OCC semantics are NOT acquired by this ticket
  // =========================================================================

  describe('neither method acquires OCC semantics', () => {
    it('softDelete/restore use `update` with an id-only predicate — never `updateMany` with a version predicate', async () => {
      harness.txDelegate.update.mockResolvedValue({ id: 'e-1' });

      await harness.repo.softDelete('e-1', 'admin-1', harness.tx);
      await harness.repo.restore('e-1', 'admin-1', harness.tx);

      for (const [args] of harness.txDelegate.update.mock.calls) {
        // An id-only `where`: bumping `version` in `data` is a state stamp,
        // NOT a compare-and-set. `updateWithVersion` remains the only CAS path.
        expect(args.where).toEqual({ id: 'e-1' });
        expect(args.where).not.toHaveProperty('version');
      }
      expect(harness.txDelegate.updateMany).not.toHaveBeenCalled();
      expect(harness.db.updateMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // T-8 — the defect, modelled: does the write actually roll back?
  // =========================================================================

  describe('a soft-delete inside a failing transaction leaves nothing behind', () => {
    /**
     * A transaction that actually rolls back: writes are journalled, and a
     * rejection discards the journal before rethrowing. Only writes issued
     * through the TX delegate are journalled — a write on the ambient client
     * is recorded as `committed` directly, because a rollback of this
     * transaction cannot reach it. That is the whole defect, modelled.
     *
     * This is what makes the assertion non-vacuous. `expect(committed).toEqual([])`
     * ALONE would pass against a repository that never issues the write at all,
     * so every case below also asserts the write was genuinely ATTEMPTED
     * through the tx delegate.
     */
    function journallingTransaction(h: Awaited<ReturnType<typeof buildHarness>>) {
      const journal: string[] = [];
      const committed: string[] = [];

      h.txDelegate.update.mockImplementation(async (args: any) => {
        journal.push(args.data.resourceStatus === 'DELETED' ? 'soft-delete' : 'restore');
        return { id: 'e-1' };
      });
      h.db.update.mockImplementation(async (args: any) => {
        // Outside the tx — survives any rollback.
        committed.push(args.data.resourceStatus === 'DELETED' ? 'soft-delete' : 'restore');
        return { id: 'e-1' };
      });

      const runInTransaction = async (work: (tx: any) => Promise<unknown>) => {
        journal.length = 0;
        try {
          const out = await work(h.tx);
          committed.push(...journal); // COMMIT
          return out;
        } catch (err) {
          journal.length = 0; // ROLLBACK
          throw err;
        }
      };

      return { committed, runInTransaction };
    }

    it('rolls the soft-delete back when a later write in the same transaction fails', async () => {
      const { committed, runInTransaction } = journallingTransaction(harness);
      let entered = 0;

      await expect(
        runInTransaction(async (tx) => {
          entered += 1;
          await harness.repo.softDelete('e-1', 'admin-1', tx);
          throw new Error('later write failed');
        }),
      ).rejects.toThrow('later write failed');

      // Non-vacuity: the transaction was genuinely entered and the soft-delete
      // was genuinely ATTEMPTED through the tx delegate. Without these two
      // lines the `committed` assertion below would also pass against a
      // repository that issued no write whatsoever.
      expect(entered).toBe(1);
      expect(harness.txDelegate.update).toHaveBeenCalledTimes(1);

      // …and nothing survived the rollback.
      expect(committed).toEqual([]);
    });

    it('rolls the restore back when a later write in the same transaction fails', async () => {
      const { committed, runInTransaction } = journallingTransaction(harness);
      let entered = 0;

      await expect(
        runInTransaction(async (tx) => {
          entered += 1;
          await harness.repo.restore('e-1', 'admin-1', tx);
          throw new Error('later write failed');
        }),
      ).rejects.toThrow('later write failed');

      expect(entered).toBe(1);
      expect(harness.txDelegate.update).toHaveBeenCalledTimes(1);
      expect(committed).toEqual([]);
    });

    it('a successful transaction DOES commit the soft-delete — the rollback test is not passing by writing nothing', async () => {
      const { committed, runInTransaction } = journallingTransaction(harness);

      await runInTransaction(async (tx) => {
        await harness.repo.softDelete('e-1', 'admin-1', tx);
      });

      expect(committed).toEqual(['soft-delete']);
    });

    it('WITHOUT `tx` the write escapes the rollback — the gap this ticket closes', async () => {
      const { committed, runInTransaction } = journallingTransaction(harness);

      await expect(
        runInTransaction(async () => {
          // The pre-TASK-680 call shape: no tx to pass, so the write goes to
          // the cached extended client and commits independently.
          await harness.repo.softDelete('e-1', 'admin-1');
          throw new Error('later write failed');
        }),
      ).rejects.toThrow('later write failed');

      // The soft-delete SURVIVED a rolled-back transaction. This is the exact
      // failure shape that cost TASK-615 a hand-written repository subclass.
      expect(committed).toEqual(['soft-delete']);
      expect(harness.db.update).toHaveBeenCalledTimes(1);
    });
  });
});
