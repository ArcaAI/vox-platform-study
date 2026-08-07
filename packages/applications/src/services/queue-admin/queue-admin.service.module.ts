import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../baseServices';
import { QueueAdminService } from './queue-admin.service';
import { JobAdminService } from './job-admin.service';
import { SchedulerAdminService } from './scheduler-admin.service';
import { JobDataRedactorService } from './job-data-redactor.service';
import { QueueEventsService } from './queue-events.service';
import { IQueueAdminService } from './IQueueAdminService';
import { IJobAdminService } from './IJobAdminService';
import { ISchedulerAdminService } from './ISchedulerAdminService';

@Module({
  imports: [CommonServiceModule],
  providers: [
    JobDataRedactorService,
    QueueEventsService,
    QueueAdminService,
    JobAdminService,
    SchedulerAdminService,
    {
      provide: IQueueAdminService,
      // useExisting, not useClass — useClass would construct a second
      // QueueAdminService instance instead of aliasing the one above. It's a
      // stateless wrapper over `ModuleRef`/BullMQ `Queue` (Nest/BullMQ
      // singletons), so the duplicate was harmless, but aliasing is free.
      useExisting: QueueAdminService,
    },
    {
      provide: IJobAdminService,
      // Same reasoning as IQueueAdminService above — JobAdminService is a
      // stateless wrapper over `ModuleRef`/`Queue`.
      useExisting: JobAdminService,
    },
    {
      provide: ISchedulerAdminService,
      // Same reasoning again. SchedulerAdminService reads/mutates jobs
      // through the injected `SchedulerRegistry` (itself a Nest singleton)
      // and holds no state of its own — it does not register anything
      // under a fixed name, unlike OriginRegistryService's `@Cron` backstop.
      useExisting: SchedulerAdminService,
    },
  ],
  exports: [IQueueAdminService, IJobAdminService, ISchedulerAdminService, QueueEventsService, JobDataRedactorService],
})
export class QueueAdminServiceModule {}
