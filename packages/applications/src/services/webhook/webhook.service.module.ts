import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { WebhookService } from './webhook.service';
import { IWebhookService } from './IWebhookService';
import { WebhookDeliveryProcessor, WebhookDeliveryDispatchProcessor } from './webhook-delivery.processor';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';

/**
 * Registers both delivery-side queues (TASK-727):
 *  - `JobQueue.SysEvent` — ALREADY registered app-wide by
 *    `RedisServiceModule.register` (via `CommonServiceModule`), but that
 *    registration's exports don't include the BullMQ queue provider itself
 *    (only `IRedisService`), so `@Processor(JobQueue.SysEvent)` still needs
 *    its own `BullModule.registerQueue` here to resolve — same pattern
 *    `auditLog.service.module.ts` already uses for `JobQueue.AuditLog`.
 *  - `JobQueue.WebhookDelivery` — net-new, this ticket's per-webhook retry
 *    queue (see `webhook-delivery.processor.ts` for the two-stage design).
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    HttpModule,
    BullModule.registerQueue({ name: JobQueue.SysEvent }),
    BullModule.registerQueue({ name: JobQueue.WebhookDelivery }),
  ],
  providers: [
    {
      provide: IWebhookService,
      useClass: WebhookService,
    },
    WebhookDeliveryProcessor,
    WebhookDeliveryDispatchProcessor,
  ],
  exports: [IWebhookService],
})
export class WebhookServiceModule {}
