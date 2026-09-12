import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';

import { CommonServiceModule } from '../baseServices';
import { UsageLedgerServiceModule } from '../usageLedger/usage-ledger.service.module';
import { IStorageSnapshotService } from './IStorageSnapshotService';
import { StorageSnapshotService } from './storage-snapshot.service';

/**
 * Registers the self-scheduling {@link StorageSnapshotService} (TASK-959 §5.2).
 *
 * Same wiring as `MeteringServiceModule` — the app-level globals
 * `ScheduleModule.forRoot()` (SchedulerRegistry) and
 * `EventEmitterModule.forRoot()` (`@OnEvent`), `CommonServiceModule` for the
 * cached `IAppSettingsService`, `CoreDatabaseModule` for the
 * `CORE_DATABASE_SERVICE` token the unscoped cross-tenant aggregates use —
 * plus `UsageLedgerServiceModule` for the emission port, since unlike the
 * meter reconcile this job's output is a LEDGER row, not a snapshot table.
 *
 * Exports `IStorageSnapshotService` so an operator surface (or a backfill) can
 * re-run one tenant or one day on demand; the intent-derived idempotency key
 * makes that safe to invoke at any time.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, UsageLedgerServiceModule],
  providers: [
    {
      provide: IStorageSnapshotService,
      useClass: StorageSnapshotService,
    },
  ],
  exports: [IStorageSnapshotService],
})
export class StorageSnapshotServiceModule {}
