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
import { HarnessPolicyServiceModule } from '../../harness-policy/harness-policy.service.module';
import { ConfigResolverModule } from '../../config-resolver';
import { AiTaskDefaultServiceModule } from '../../ai-task-default/ai-task-default.service.module';
import { UsageLedgerServiceModule } from '../../usageLedger';
import { NoteGenerationServiceModule } from '../note-generation/note-generation.service.module';
import { HarnessAuditServiceModule } from '../../harness-audit/harness-audit.service.module';
import { PhiRedactionServiceModule } from '../../phi-redaction/phi-redaction.service.module';

@Module({
  imports: [
    ConfigModule,
    HttpModule,
    CoreDatabaseModule,
    ObservabilityModule,
    ChainSummaryServiceModule, // Required for ComprehensiveSummaryProcessor
    PromptResolutionServiceModule, // Required for prompt fallback chain
    NoteGenerationServiceModule, // TASK-704 seam — harnessEnabled routing for ConsultationEventHandler + SummaryProcessor
    HarnessPolicyServiceModule, // SMR-selection resolver for the summary/pre-summary/comprehensive processors
    AiTaskDefaultServiceModule, // nlp.ner model-injection resolver for NerProcessor
    ConfigResolverModule, // Realtime cascade + preferred-prompt threading (handler + summary processor)
    UsageLedgerServiceModule, // ner.extract usage emission for NerProcessor
    PhiRedactionServiceModule, // TASK-710 hop 1 — IPhiRedactor for NerProcessor's pseudonymize-before-NLP call
    HarnessAuditServiceModule, // TASK-714 — WORM GENERATE event for the legacy safety floor (SummaryProcessor)
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
    ConsultationEventHandler, // Auto-pipeline event handler
  ],
  exports: [IConsultationJobService, ConsultationEventHandler],
})
export class ConsultationJobServiceModule {}
