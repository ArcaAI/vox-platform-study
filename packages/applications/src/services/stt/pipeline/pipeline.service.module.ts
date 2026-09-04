import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { PipelineService } from './pipeline.service';
import { PipelineTemplateResyncService } from './pipeline-template-resync.service';
import { PipelineTemplateResyncCronService } from './pipeline-template-resync.cron.service';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';
import { CommonServiceModule } from '../../baseServices';

/**
 * The module additionally registers the template-resync reconciler
 * and its self-scheduling cron. Like `AgentTrajectoryRetentionServiceModule`,
 * the cron relies on the app-level `ScheduleModule.forRoot()` (SchedulerRegistry)
 * and `EventEmitterModule.forRoot()` (@OnEvent) globals; `CommonServiceModule`
 * supplies `IAppSettingsService` (the enabled/cron keys, default OFF).
 */
@Module({
  imports: [CoreDatabaseModule, EventEmitterModule, ClsModule, EntitlementsServiceModule, CommonServiceModule],
  providers: [PipelineService, PipelineTemplateResyncService, PipelineTemplateResyncCronService],
  exports: [PipelineService, PipelineTemplateResyncService],
})
/** @deprecated TASK-861 — removed in R4. Import `AsrAgentResolverServiceModule` instead. */
export class PipelineServiceModule {}
