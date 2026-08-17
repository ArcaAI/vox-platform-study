import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { RedisCacheModule } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { ConsultationJobService, IConsultationJobService } from './consultation-job.service';
import { PreSummaryProcessor } from './processors/pre-summary.processor';
import { ComprehensiveSummaryProcessor } from './processors/comprehensive-summary.processor';
import { ConsultationEventHandler } from '../events/consultation-event.handler';
import { ChainSummaryServiceModule } from '../summary/chain-summary.service.module';
import { PromptResolutionServiceModule } from '../prompt/prompt-resolution.service.module';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { ObservabilityModule } from '../../baseServices/observability/observability.module';
import { HarnessPolicyServiceModule } from '../../harness-policy/harness-policy.service.module';
import { ConfigResolverModule } from '../../config-resolver';
import { UsageLedgerServiceModule } from '../../usageLedger';
import { NoteGenerationServiceModule } from '../note-generation/note-generation.service.module';

@Module({
  imports: [
    ConfigModule,
    HttpModule,
    CoreDatabaseModule,
    ObservabilityModule,
    ChainSummaryServiceModule, // Required for ComprehensiveSummaryProcessor
    PromptResolutionServiceModule, // Required for prompt fallback chain
    NoteGenerationServiceModule, // TASK-704 seam — harnessEnabled routing for ConsultationEventHandler
    HarnessPolicyServiceModule, // SMR-selection resolver for the pre-summary/comprehensive processors
    ConfigResolverModule, // Realtime cascade + preferred-prompt threading (handler + pre-summary/comprehensive processors)
    UsageLedgerServiceModule, // usage emission for ComprehensiveSummaryProcessor
    EventEmitterModule, // Required for @OnEvent handlers and EventEmitter2 injection
    RedisCacheModule.register(), // For job status storage and pub/sub
    // TASK-732 — `GenerateSummary`/`ExtractNamedEntities` (the legacy
    // signable-generator queues) were removed here along with
    // `SummaryProcessor`/`NerProcessor`. `GeneratePreSummary`/
    // `GenerateComprehensiveSummary` survive per the R-2 boundary (kept,
    // non-signable helper generators — see deletion-manifest.md §5).
    BullModule.registerQueue({ name: JobQueue.GeneratePreSummary }, { name: JobQueue.GenerateComprehensiveSummary }),
  ],
  providers: [
    RedisSubscriberService, // Dedicated Redis subscriber for SSE pub/sub
    {
      provide: IConsultationJobService,
      useClass: ConsultationJobService,
    },
    PromptAssemblyService,
    PreSummaryProcessor,
    ComprehensiveSummaryProcessor,
    ConsultationEventHandler, // Auto-pipeline event handler
  ],
  exports: [IConsultationJobService, ConsultationEventHandler],
})
export class ConsultationJobServiceModule {}
