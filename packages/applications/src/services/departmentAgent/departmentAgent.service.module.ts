import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { DepartmentAgentService } from './departmentAgent.service';
import { IDepartmentAgentService } from './IDepartmentAgentService';
import { AgentTemplateResyncService } from './agent-template-resync.service';
import { AgentTemplateResyncCronService } from './agent-template-resync.cron.service';
import { CommonServiceModule } from '../baseServices';
import { EvalServiceModule } from '../eval/eval.service.module';

/**
 * The module additionally registers the agent golden-library template-resync
 * reconciler and its self-scheduling cron (TASK-548) — the DepartmentAgent
 * sibling of the pipeline resync (TASK-531). Like the pipeline module, the cron
 * relies on the app-level `ScheduleModule.forRoot()` (SchedulerRegistry) and
 * `EventEmitterModule.forRoot()` (@OnEvent) globals; `CommonServiceModule`
 * supplies `IAppSettingsService` (the enabled/cron keys, default OFF).
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EventEmitterModule, ClsModule, EvalServiceModule],
  providers: [
    DepartmentAgentService,
    {
      provide: IDepartmentAgentService,
      // useExisting, not useClass — useClass would construct a second
      // DepartmentAgentService instance instead of aliasing the one above.
      // DepartmentAgentService itself holds no state and isn't the
      // self-scheduling piece here (that's AgentTemplateResyncCronService,
      // provided once, below), so the duplicate was harmless — aliasing is
      // still free.
      useExisting: DepartmentAgentService,
    },
    AgentTemplateResyncService,
    AgentTemplateResyncCronService,
  ],
  exports: [IDepartmentAgentService, DepartmentAgentService, AgentTemplateResyncService, AgentTemplateResyncCronService],
})
export class DepartmentAgentServiceModule {}
