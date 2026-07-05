import { NotificationServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';

/** TASK-419 item 2 — mounts the `/admin/notifications*` surface. */
@Module({
  imports: [NotificationServiceModule],
  controllers: [NotificationController],
})
export class NotificationModule {}
