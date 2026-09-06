import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { RedisCacheModule } from '../../baseServices/redis/redis-cache.module';
import { InferenceReadinessServiceModule } from '../../ai-readiness/inference-readiness.service.module';
import { ModelInventoryService } from './model-inventory.service';
import { ModelInventoryCronService } from './model-inventory.cron.service';

/**
 * ModelInventoryServiceModule — the availability measurement of the model
 * registry (TASK-860 §3.4): the on-demand inventory service and its
 * settings-gated cron. `CommonServiceModule` supplies `IS3Service` +
 * `IAppSettingsService`; `CoreDatabaseModule` the repository and the base
 * client. The cron relies on the app-level `ScheduleModule.forRoot()`
 * (SchedulerRegistry), like `PipelineServiceModule`'s resync cron.
 *
 * TASK-890 J1 MINOR-6/7 adds two more, both consumed `@Optional()`:
 * `RedisCacheModule` so the last report outlives the browser tab that produced
 * it, and `InferenceReadinessServiceModule` so a run re-observes the readiness
 * it just invalidated (the inventory is the only scheduled writer of
 * `AiModel.availability`, which is half of every self-hosted row's verdict).
 * No cycle: the readiness module reads `AiModelRepository` from
 * `CoreDatabaseModule` and imports nothing from this one.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, RedisCacheModule.register(), InferenceReadinessServiceModule],
  providers: [ModelInventoryService, ModelInventoryCronService],
  exports: [ModelInventoryService],
})
export class ModelInventoryServiceModule {}
