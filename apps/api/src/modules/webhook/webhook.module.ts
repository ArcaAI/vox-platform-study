import { WebhookServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';

/** Mounts the `/admin/webhooks*` surface. */
@Module({
  imports: [WebhookServiceModule],
  controllers: [WebhookController],
})
export class WebhookModule {}
