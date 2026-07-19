import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../baseServices';
import { AgentTrajectoryServiceModule } from '../agent-trajectory';
import { AgentTrajectoryRetentionService } from './agent-trajectory-retention.service';

/**
 * TASK-510 — registers the self-scheduling {@link AgentTrajectoryRetentionService}.
 *
 * Relies on the app-level globals `ScheduleModule.forRoot()` (SchedulerRegistry)
 * and `EventEmitterModule.forRoot()` (@OnEvent). `CommonServiceModule` provides
 * `IAppSettingsService`; `AgentTrajectoryServiceModule` provides the prune path.
 */
@Module({
  imports: [CommonServiceModule, AgentTrajectoryServiceModule],
  providers: [AgentTrajectoryRetentionService],
  exports: [AgentTrajectoryRetentionService],
})
export class AgentTrajectoryRetentionServiceModule {}
