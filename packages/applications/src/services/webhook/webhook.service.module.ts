import { Module } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { IWebhookService } from './IWebhookService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';

// TODO: Implement this

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IWebhookService,
      useClass: WebhookService,
    },
  ],
  exports: [IWebhookService],
})
export class WebhookServiceModule {}
