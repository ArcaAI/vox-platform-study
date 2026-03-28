import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { RedisCacheModule } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { ConsultationJobService, IConsultationJobService } from './consultation-job.service';
import { SummaryProcessor } from './processors/summary.processor';
import { PreSummaryProcessor } from './processors/pre-summary.processor';
import { NerProcessor } from './processors/ner.processor';
import { ComprehensiveSummaryProcessor } from './processors/comprehensive-summary.processor';
import { ConsultationEventHandler } from '../events/consultation-event.handler';
import { ChainSummaryServiceModule } from '../summary/chain-summary.service.module';
import { PromptResolutionServiceModule } from '../prompt/prompt-resolution.service.module';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { ObservabilityModule } from '../../baseServices/observability/observability.module';

@Module({
  imports: [
    ConfigModule,
    HttpModule,
    CoreDatabaseModule,
    ObservabilityModule,
    ChainSummaryServiceModule, // Required for ComprehensiveSummaryProcessor
    PromptResolutionServiceModule, // Required for prompt fallback chain (GAP-3)
    EventEmitterModule, // Required for @OnEvent handlers and EventEmitter2 injection
    RedisCacheModule.register(), // For job status storage and pub/sub
    BullModule.registerQueue(
      { name: JobQueue.GeneratePreSummary },
      { name: JobQueue.GenerateSummary },
      { name: JobQueue.GenerateComprehensiveSummary },
      { name: JobQueue.ExtractNamedEntities },
    ),
  ],
  providers: [
    RedisSubscriberService, // Dedicated Redis subscriber for SSE pub/sub
    {
      provide: IConsultationJobService,
      useClass: ConsultationJobService,
    },
    PromptAssemblyService,
    SummaryProcessor,
    PreSummaryProcessor,
    NerProcessor,
    ComprehensiveSummaryProcessor,
    ConsultationEventHandler, // Auto-pipeline event handler (GAP-1)
  ],
  exports: [IConsultationJobService, ConsultationEventHandler],
})
export class ConsultationJobServiceModule {}
