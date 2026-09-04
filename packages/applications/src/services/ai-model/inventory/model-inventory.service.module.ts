import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { ModelInventoryService } from './model-inventory.service';
import { ModelInventoryCronService } from './model-inventory.cron.service';

/**
 * ModelInventoryServiceModule — the availability measurement of the model
 * registry (TASK-860 §3.4): the on-demand inventory service and its
 * settings-gated cron. `CommonServiceModule` supplies `IS3Service` +
 * `IAppSettingsService`; `CoreDatabaseModule` the repository and the base
 * client. The cron relies on the app-level `ScheduleModule.forRoot()`
 * (SchedulerRegistry), like `PipelineServiceModule`'s resync cron.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [ModelInventoryService, ModelInventoryCronService],
  exports: [ModelInventoryService],
})
export class ModelInventoryServiceModule {}
