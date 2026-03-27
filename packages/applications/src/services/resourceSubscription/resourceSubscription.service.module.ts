import { Module } from '@nestjs/common';
import { ResourceSubscriptionService } from './resourceSubscription.service';
import { IResourceSubscriptionService } from './IResourceSubscriptionService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { UserServiceModule } from '../user/user/user.service.module';

// TODO: Implement this

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, UserServiceModule],
  providers: [
    {
      provide: IResourceSubscriptionService,
      useClass: ResourceSubscriptionService,
    },
  ],
  exports: [IResourceSubscriptionService],
})
export class ResourceSubscriptionServiceModule {}
