/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/ban-ts-comment */
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

/**
 * @deprecated TASK-306 W5.7 / 306-F13 — orphan dead code.
 *
 * This class has **zero production callers** verified via
 * `rg '\bUnitOfWorkService\b'` across the entire monorepo (only
 * matches: this file + a Handlebars template that emits
 * `{{domain}}UnitOfWorkService`, e.g. `CoreUnitOfWorkService`).
 * Retained pending an explicit user-approved deletion ticket.
 *
 * If you find yourself reaching for this class, **STOP**. It exhibits
 * the same broken self-resolved-tx pattern that pre-W5.5.2
 * `CoreUnitOfWorkService.startTransaction()` had — `$transaction`'s
 * callback returns the inner client which immediately resolves the
 * transaction; the "tx" persisted into CLS is therefore a
 * post-rollback handle that does NOT carry transactional isolation
 * (no atomic multi-write rollback, no isolation level). Re-introducing
 * this pattern would re-open audit M-6.
 *
 * Use one of these instead:
 *   - `CoreUnitOfWorkService.runInTransaction(work)` at
 *     `packages/domains/src/common/unitsOfWork/core/core.unitOfWork.ts`
 *     (TASK-306 W5.5.2 canonical Prisma-7 `$transaction(callback)`
 *     pattern — atomic, isolation-aware, exception-safe rollback)
 *   - `databaseService.client.$transaction(callback)` directly when
 *     the call-site is outside the domain layer
 *
 * DO NOT resurrect this class. DO NOT add new callers.
 */
@Injectable()
export class UnitOfWorkService<T> {
  private readonly TRANSACTION_CLIENT_KEY = 'transactionClient';

  constructor(
    private readonly databaseService: T,
    private readonly cls: ClsService,
  ) {}

  /**
   * Starts a new transaction and sets the transaction context.
   */
  async startTransaction(): Promise<void> {
    // @ts-ignore
    const tx = await (this.databaseService as any).$transaction(async (txClient: any) => txClient);
    this.cls.set(`${this.TRANSACTION_CLIENT_KEY}::${(this.databaseService as any).constructor.name}`, tx);
  }

  /**
   * Gets the active database context, either transaction-aware or default.
   */
  getDatabaseService(): T {
    return this.cls.get(`${this.TRANSACTION_CLIENT_KEY}::${(this.databaseService as any).constructor.name}`) || this.databaseService;
  }

  /**
   * Ends the transaction context.
   */
  endTransaction(): void {
    this.cls.set(`${this.TRANSACTION_CLIENT_KEY}::${(this.databaseService as any).constructor.name}`, null);
  }
}
