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
      useClass: QueueAdminService,
    },
    {
      provide: IJobAdminService,
      useClass: JobAdminService,
    },
    {
      provide: ISchedulerAdminService,
      useClass: SchedulerAdminService,
    },
  ],
  exports: [
    IQueueAdminService,
    IJobAdminService,
    ISchedulerAdminService,
    QueueEventsService,
    JobDataRedactorService,
  ],
})
export class QueueAdminServiceModule {}
