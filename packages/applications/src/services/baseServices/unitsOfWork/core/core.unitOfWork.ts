import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { CorePrisma, CoreDatabaseService } from '@arcaai/domains';

// Type for database context - either extended client or transaction client
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseContext = any;

/**
 * ⚠️ UNWIRED — DO NOT INJECT THIS CLASS. It appears in no NestJS
 * `providers: []` array anywhere in the repo and is not exported from the
 * `@arcaai/applications` barrel, so `@Inject(CoreUnitOfWorkService)` against
 * it resolves to `undefined` (silently, under `@Optional()`). Inject the
 * DOMAINS class of the same name instead —
 * `import { CoreUnitOfWorkService } from '@arcaai/domains'` — which
 * `CoreDatabaseModule` both provides and exports.
 *
 * This trap already cost a shipped-but-dead metering path (both
 * summary services took the unmetered fallback branch in production while
 * their unit tests passed). Guarded now by
 * `services/consultation/summary/__tests__/usage-ledger.di-wiring.task615.test.ts`.
 *
 * The class is retained only because its own test file is a named entry in the
 * `cross-tenant-coverage` manifest; it has no other consumer and no production
 * caller.
 *
 * No production caller uses the legacy
 * `startTransaction/endTransaction/transactionClient` wrapper pattern — an
 * `rg "transactionClient" packages/applications/src packages/domains/src`
 * sweep returns ONLY hits inside the unit-of-work implementation itself (its
 * private field, the CLS key constant, its tests). The proven production
 * transactional flow is `this.databaseService.baseClient.$transaction(callback)`
 * invoked directly (see `TenantService` for the canonical example).
 *
 * The two integration-test stubs that reference `startTransaction` /
 * `endTransaction` at
 * `packages/domains/src/integration/repository-soft-delete.integration.test.ts:40-41`
 * are mock implementations of the IUnitOfWork shape; they are not call
 * sites and do not need migration.
 */
@Injectable()
export class CoreUnitOfWorkService {
  private readonly TRANSACTION_CLIENT_KEY = 'coreTransactionClient';
  private readonly logger = new Logger(CoreUnitOfWorkService.name);
  /**
   * @deprecated legacy state-machine field. Kept
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
   * isolation in Prisma 7. New callers must use this
   * method.
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
   * @deprecated the wrapper pattern (open tx,
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
   * @deprecated see `startTransaction()`.
   * `runInTransaction(work)` manages tx lifecycle automatically.
   */
  endTransaction(): void {
    this.transactionClient = null;
    this.cls.set(this.TRANSACTION_CLIENT_KEY, null);
  }
}
