/**
 * `BillingService.recordPlanChange` is genuinely atomic.
 *
 * Closes the TASK-677 audit finding recorded in
 * `docs/implementation/TASK-677-Transactional-Write-Sequences/README.md` §6.1,
 * deliberately left unfixed there because it changes billing behaviour.
 *
 * The method wraps its two writes — CLOSE the current plan window, OPEN the
 * successor — in `runInTransaction` precisely so a period is never left
 * double-covered or gapped. But the close was issued as
 * `update(open.id, open)` with no `tx`, under the (false) belief that a
 * repository joins an in-flight transaction through the shared unit-of-work
 * context. It does not: `Repository` resolves and CACHES `_databaseContext` in
 * its constructor, and repositories are NestJS singletons constructed at boot
 * when no transaction exists — so the cache is permanently the extended
 * client and the CLS `coreTransactionClient` published by `runInTransaction`
 * is never consulted again. That is pinned by
 * `packages/domains/src/common/__tests__/update.transaction.task677.test.ts`
 * ("a constructed repository NEVER observes a later CLS tx client").
 *
 * Consequence: the close committed OUTSIDE the transaction while the open ran
 * inside it. A failing `create` rolled back only the open, leaving the
 * tenant's plan history with a GAP — no window in force from `effectiveAt`
 * onward — which is exactly the failure the transaction was written to
 * prevent. TASK-677 (`0002b78d3`) added the optional `tx` parameter to
 * `Repository.update`, so the close can now join the transaction.
 *
 * Fixture style follows `agentPromotion/__tests__/agentPromotion.transaction.task677.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TenantPlan } from '@arcaai/domains';
import { BillingService } from '../billing.service';

const TENANT = 'tenant-1';

/** The marker handed to `work(tx)` — identity is what the assertions check. */
const TX = { __transactionClient: true };

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockPlanHistoryRepository = {
  findOpenWindow: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const mockUnitOfWork = {
  runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX)),
};

const noopRepo = () => ({}) as never;

function buildService() {
  return new BillingService(
    mockEventEmitter as never,
    mockClsService as never,
    noopRepo(), // invoiceRepository
    noopRepo(), // lineRepository
    noopRepo(), // adjustmentRepository
    noopRepo(), // rollupRepository
    noopRepo(), // usageAggregateRepository
    noopRepo(), // planEntitlementRepository
    noopRepo(), // tenantEntitlementRepository
    noopRepo(), // tenantRepository
    mockPlanHistoryRepository as never,
    noopRepo(), // priceBook
    mockUnitOfWork as never,
  );
}

/** The window currently in force — the row `recordPlanChange` must close. */
const openWindow = () => ({
  id: 'window-1',
  tenantId: TENANT,
  plan: TenantPlan.STARTER,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null as Date | null,
  supersedeAt: vi.fn(),
});

describe('BillingService.recordPlanChange is transactional (TASK-677 §6.1)', () => {
  let service: BillingService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'admin-1', roles: ['GLOBAL_ADMIN'] } : null));
    mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(TX));
    mockPlanHistoryRepository.create.mockImplementation(async (e: unknown) => e);
    mockPlanHistoryRepository.update.mockImplementation(async (_id: string, e: unknown) => e);
    service = buildService();
  });

  describe('both writes of a plan change go through ONE transaction client', () => {
    it('opens exactly one transaction', async () => {
      mockPlanHistoryRepository.findOpenWindow.mockResolvedValue(openWindow());

      await service.recordPlanChange(TENANT, TenantPlan.PRO, new Date('2026-02-01T00:00:00Z'), 'upgrade');

      expect(mockUnitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
    });

    it('CLOSES the current window through the tx client — the write the false comment left outside', async () => {
      mockPlanHistoryRepository.findOpenWindow.mockResolvedValue(openWindow());

      await service.recordPlanChange(TENANT, TenantPlan.PRO, new Date('2026-02-01T00:00:00Z'), 'upgrade');

      expect(mockPlanHistoryRepository.update).toHaveBeenCalledTimes(1);
      const [id, , tx] = mockPlanHistoryRepository.update.mock.calls[0];
      expect(id).toBe('window-1');
      expect(tx).toBe(TX);
    });

    it('OPENS the successor window through the same tx client', async () => {
      mockPlanHistoryRepository.findOpenWindow.mockResolvedValue(openWindow());

      await service.recordPlanChange(TENANT, TenantPlan.PRO, new Date('2026-02-01T00:00:00Z'), 'upgrade');

      expect(mockPlanHistoryRepository.create).toHaveBeenCalledTimes(1);
      expect(mockPlanHistoryRepository.create.mock.calls[0][1]).toBe(TX);
    });
  });

  describe('a failing OPEN leaves no gap — the CLOSE does not survive', () => {
    /**
     * A transaction that actually rolls back: writes are journalled, and a
     * rejection discards the journal before rethrowing. Only writes carrying
     * the TX marker are journalled — a write issued on the ambient client
     * (the bug) is recorded as `committed` directly, because a rollback of
     * this transaction cannot reach it. That is the whole defect, modelled.
     */
    function journallingTransaction() {
      const journal: string[] = [];
      const committed: string[] = [];
      const record = (name: string, tx: unknown) => {
        if (tx === TX) journal.push(name);
        else committed.push(name); // outside the tx — survives any rollback
      };
      mockPlanHistoryRepository.update.mockImplementation(async (_id: string, e: unknown, tx?: unknown) => {
        record('close', tx);
        return e;
      });
      mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
        journal.length = 0;
        try {
          const out = await work(TX);
          committed.push(...journal);
          return out;
        } catch (err) {
          journal.length = 0; // ROLLBACK
          throw err;
        }
      });
      return { committed };
    }

    it('rolls the CLOSE back when the successor insert fails, so the tenant keeps a window in force', async () => {
      const { committed } = journallingTransaction();
      mockPlanHistoryRepository.findOpenWindow.mockResolvedValue(openWindow());
      mockPlanHistoryRepository.create.mockRejectedValue(new Error('plan history insert failed'));

      await expect(service.recordPlanChange(TENANT, TenantPlan.PRO, new Date('2026-02-01T00:00:00Z'), 'upgrade')).rejects.toThrow(
        'plan history insert failed',
      );

      // Non-vacuity: the close was genuinely ATTEMPTED, and the successor
      // insert was genuinely attempted inside the transaction. Without these
      // two lines the `committed` assertion would also pass on a service that
      // never issues the close at all.
      expect(mockPlanHistoryRepository.update).toHaveBeenCalledTimes(1);
      expect(mockPlanHistoryRepository.create).toHaveBeenCalledWith(expect.anything(), TX);

      // …and nothing survived: no closed window without a successor, i.e. no gap.
      expect(committed).toEqual([]);
    });
  });

  describe('the paths that write nothing are unchanged', () => {
    it('is a no-op when the plan already in force is re-recorded', async () => {
      mockPlanHistoryRepository.findOpenWindow.mockResolvedValue({ ...openWindow(), plan: TenantPlan.PRO });

      await service.recordPlanChange(TENANT, TenantPlan.PRO, new Date('2026-02-01T00:00:00Z'));

      expect(mockUnitOfWork.runInTransaction).not.toHaveBeenCalled();
      expect(mockPlanHistoryRepository.update).not.toHaveBeenCalled();
      expect(mockPlanHistoryRepository.create).not.toHaveBeenCalled();
    });

    it('opens the first window with no close to issue', async () => {
      mockPlanHistoryRepository.findOpenWindow.mockResolvedValue(null);

      await service.recordPlanChange(TENANT, TenantPlan.STARTER, new Date('2026-01-01T00:00:00Z'), 'initial');

      expect(mockPlanHistoryRepository.update).not.toHaveBeenCalled();
      expect(mockPlanHistoryRepository.create.mock.calls[0][1]).toBe(TX);
    });

    it('closes the last window through the tx client when the tenant drops to no plan', async () => {
      mockPlanHistoryRepository.findOpenWindow.mockResolvedValue(openWindow());

      await service.recordPlanChange(TENANT, null, new Date('2026-03-01T00:00:00Z'), 'cancelled');

      expect(mockPlanHistoryRepository.update.mock.calls[0][2]).toBe(TX);
      expect(mockPlanHistoryRepository.create).not.toHaveBeenCalled();
    });
  });
});
