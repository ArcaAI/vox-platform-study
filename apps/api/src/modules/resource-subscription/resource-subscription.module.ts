import { ResourceSubscriptionServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { ResourceSubscriptionController } from './resource-subscription.controller';

/** Mounts the `/admin/resource-subscriptions*` surface. */
@Module({
  imports: [ResourceSubscriptionServiceModule],
  controllers: [ResourceSubscriptionController],
})
export class ResourceSubscriptionModule {}
