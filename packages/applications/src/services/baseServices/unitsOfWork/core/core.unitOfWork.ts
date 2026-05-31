import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { CorePrisma, CoreDatabaseService } from '@arcaai/domains';

// Type for database context - either extended client or transaction client
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseContext = any;

/**
 * TASK-306 W5.5.3 — `transactionClient` caller sweep result
 * --------------------------------------------------------
 * After the W5.5.2 fix added the canonical `runInTransaction(work)`
 * method, an `rg "transactionClient" packages/applications/src
 * packages/domains/src` sweep returned ONLY hits inside the unit-of-work
 * implementation itself (its private field, the CLS key constant, its
 * tests). NO production caller exists that uses the
 * `startTransaction/endTransaction/transactionClient` wrapper pattern —
 * the proven production transactional flow is
 * `this.databaseService.baseClient.$transaction(callback)` invoked
 * directly (see `TenantService` TASK-302 D.4 for the canonical example).
 *
 * The two integration-test stubs that reference `startTransaction` /
 * `endTransaction` at
 * `packages/domains/src/integration/repository-soft-delete.integration.test.ts:40-41`
 * are mock implementations of the IUnitOfWork shape; they are not call
 * sites and do not need migration.
 *
 * Net: the W5.5.3 sweep was a verification — no migration was required,
 * which is the success state per the plan README (Wave 5.5 verify
 * gate "rg 'baseClient\\.\\$transaction' packages/applications returns
 * only documented exceptions").
 */
@Injectable()
export class CoreUnitOfWorkService {
  private readonly TRANSACTION_CLIENT_KEY = 'coreTransactionClient';
  private readonly logger = new Logger(CoreUnitOfWorkService.name);
  /**
   * @deprecated TASK-306 P3.2 / AC-11 — legacy state-machine field. Kept
   * only so existing tests + (no) production callers continue to compile
   * while they migrate. The canonical Prisma 7 pattern is
   * `runInTransaction(work)` below; do not write new callers against
   * this field.
   */
  private transactionClient: CorePrisma.TransactionClient | null = null;

  constructor(
    @Inject('CORE_DATABASE_SERVICE')
    private readonly databaseService: CoreDatabaseService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Run `work` inside a Prisma `$transaction(callback)`. If `work`
   * rejects or throws, Prisma rolls back every write made through the
   * `tx` client. The tx client is also exposed to nested repository
   * calls via CLS (`coreTransactionClient` key), so existing
   * `getDatabaseService()` consumers transparently pick up `tx` while
   * the work is in flight.
   *
   * This is the canonical Prisma 7 transactional API and the
   * REPLACEMENT for the legacy `startTransaction()/endTransaction()`
   * wrapper pair below — which never actually carried transactional
   * isolation in Prisma 7 (audit M-6). New callers must use this
   * method. TASK-306 P3.2 / AC-11.
   *
   * @typeParam T - The work callback's return type.
   * @param work - Async callback receiving the `tx` client; its writes
   *               are atomic relative to one another.
   * @returns The work callback's resolved value (committed).
   * @throws Whatever `work` throws — Prisma rolls back the tx first.
   */
  async runInTransaction<T>(work: (tx: CorePrisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.databaseService.baseClient.$transaction(async (tx) => {
      this.cls.set(this.TRANSACTION_CLIENT_KEY, tx);
      try {
        return await work(tx);
      } finally {
        this.cls.set(this.TRANSACTION_CLIENT_KEY, null);
      }
    });
  }

  /**
   * @deprecated TASK-306 P3.2 / AC-11 — the wrapper pattern (open tx,
   * return, caller runs ops out-of-band, then `endTransaction`) does
   * NOT carry transactional isolation in Prisma 7: `$transaction`
   * commits when its callback resolves, so the `tx` handed back here
   * is already closed by the time any caller writes through it. Use
   * `runInTransaction(work)` for new code; this method survives only
   * to keep the (zero) existing production call-sites compiling while
   * they migrate.
   */
  async startTransaction(): Promise<void> {
    this.logger.warn(
      'CoreUnitOfWorkService.startTransaction() is deprecated and does not provide transactional isolation in Prisma 7. Use runInTransaction(work) for atomic multi-write operations. TASK-306 P3.2 / AC-11.',
    );
    this.transactionClient = await this.databaseService.baseClient.$transaction(async (tx) => tx);
    this.cls.set(this.TRANSACTION_CLIENT_KEY, this.transactionClient);
  }

  /**
   * Get the database client for repository operations.
   * Returns the transaction client (if `runInTransaction` is in flight)
   * or the extended Prisma client otherwise.
   */
  getDatabaseService(): DatabaseContext {
    const txClient = this.cls.get(this.TRANSACTION_CLIENT_KEY);
    if (txClient) {
      return txClient;
    }
    // Return the extended client which has model accessors
    return this.databaseService.client;
  }

  /**
   * @deprecated TASK-306 P3.2 / AC-11 — see `startTransaction()`.
   * `runInTransaction(work)` manages tx lifecycle automatically.
   */
  endTransaction(): void {
    this.transactionClient = null;
    this.cls.set(this.TRANSACTION_CLIENT_KEY, null);
  }
}
