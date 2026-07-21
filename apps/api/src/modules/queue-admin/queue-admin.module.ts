import { Module } from '@nestjs/common';
import { QueueAdminServiceModule } from '@arcaai/applications';
import { QueueAdminController } from './queue-admin.controller';
import { SchedulerAdminController } from './scheduler-admin.controller';
import { QueueNamePipe } from './pipes/queue-name.pipe';

/**
 * Exposes the previously-orphaned queue/job/
 * scheduler application layer through guarded admin controllers. Imports
 * `QueueAdminServiceModule` from `@arcaai/applications` for
 * `IQueueAdminService`, `IJobAdminService`, and `ISchedulerAdminService`.
 *
 * The BullMQ queue tokens the queue/job services resolve via `ModuleRef` are
 * already registered app-wide by `RedisServiceModule.register(queueNames)` in
 * `app.module.ts`, and `ScheduleModule.forRoot()` provides the
 * `SchedulerRegistry` the scheduler service depends on.
 */
@Module({
  imports: [QueueAdminServiceModule],
  controllers: [QueueAdminController, SchedulerAdminController],
  providers: [QueueNamePipe],
})
export class QueueAdminModule {}
