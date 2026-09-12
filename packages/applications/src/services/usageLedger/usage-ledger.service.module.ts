import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';

import { CommonServiceModule } from '../baseServices';
import { PriceBookServiceModule } from '../priceBook/price-book.service.module';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { ComputeDeviceResolver, IComputeDeviceResolver } from './compute-device.resolver';
import { IUsageLedgerService } from './IUsageLedgerService';
import { UsageLedgerService } from './usage-ledger.service';
import { UsageOutboxDrainer } from './usage-outbox.drainer';
import { UsageOutboxProcessor, UsageOutboxScheduler } from './usage-outbox.processor';
import { UsageOutboxPrunerService } from './usage-outbox-pruner.service';
import { USAGE_OUTBOX_QUEUE } from './usage-ledger.constants';

/**
 * The usage-metering plane: emission port + outbox drainer.
 *
 * IMPORTS
 *   - `CoreDatabaseModule` — the four repositories (outbox, ledger, both
 *     rollups) and the `CoreUnitOfWorkService` the drainer runs its atomic
 *     append+aggregate inside.
 *   - `PriceBookServiceModule` — COST-plane rating at ingest.
 *   - `CommonServiceModule` — `IAppSettingsService` for the drain schedule.
 *   - `BullModule.registerQueue` — the periodic tick. The queue NAME is a local
 *     constant rather than a `JobQueue` member because that enum lives in
 *     `@arcaai/domains`, which is another lane's package; the shared
 *     `BullModule.forRootAsync` registered by `RedisServiceModule` is global, so
 *     this binds to the same Redis connection regardless.
 *
 * `UsageOutboxPrunerService` (the WS-B handoff item) is a
 * self-scheduling hard-delete job for already-drained (`DISPATCHED`)
 * `AiUsageOutbox` rows, same shape as `AuditRetentionService`. It needs
 * nothing this module doesn't already import.
 *
 * EXPORTS `IUsageLedgerService` and `IComputeDeviceResolver`: emitters record
 * usage and — for the LLM engines only — ask which device a self-hosted
 * provider runs on. Nothing outside this module has any business reaching into
 * the drainer or the pruner.
 *
 * `TenantSettingsService` is provided LOCALLY rather than by importing
 * `EffectiveSettingsModule`, exactly as `RateLimitServiceModule` does: that
 * module also pulls the pipeline resolver and the AI task-default service,
 * none of which metering needs, and this service's only dependency is
 * `IAppSettingsService` — already exported by `CommonServiceModule` above.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, PriceBookServiceModule, BullModule.registerQueue({ name: USAGE_OUTBOX_QUEUE })],
  providers: [
    {
      provide: IUsageLedgerService,
      useClass: UsageLedgerService,
    },
    // The `global-kv` cascade behind `metering.compute.deviceByProvider`.
    TenantSettingsService,
    {
      provide: IComputeDeviceResolver,
      useClass: ComputeDeviceResolver,
    },
    UsageOutboxDrainer,
    UsageOutboxProcessor,
    UsageOutboxScheduler,
    UsageOutboxPrunerService,
  ],
  exports: [IUsageLedgerService, IComputeDeviceResolver],
})
export class UsageLedgerServiceModule {}
