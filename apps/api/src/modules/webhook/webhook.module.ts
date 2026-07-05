import { WebhookServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';

/** TASK-419 item 2 — mounts the `/admin/webhooks*` surface. */
@Module({
  imports: [WebhookServiceModule],
  controllers: [WebhookController],
})
export class WebhookModule {}
