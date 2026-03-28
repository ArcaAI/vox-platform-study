import { Module } from '@nestjs/common';
import { ISysEventService } from './ISysEventService';
import { SysEventService } from './sysEvent.service';
import { CommonServiceModule } from '../baseServices';
import { CoreDatabaseModule } from '@arcaai/domains';
import { ResourceSubscriptionServiceModule } from '../resourceSubscription/resourceSubscription.service.module';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, ResourceSubscriptionServiceModule],
  providers: [
    {
      provide: ISysEventService,
      useClass: SysEventService,
    },
  ],
  exports: [ISysEventService],
})
export class SysEventServiceModule {}
