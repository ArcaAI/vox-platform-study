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
import { GateEditMiningServiceModule } from '../../gate-edit-mining/gate-edit-mining.service.module';
import { TextRequestServiceModule } from '../../text-request/text-request.service.module';
import { VisitTypeServiceModule } from '../visit-type/visit-type.service.module';

@Module({
  imports: [
    VisitTypeServiceModule,
    ConfigModule,
    HttpModule,
    CoreDatabaseModule,
    ObservabilityModule,
    ChainSummaryServiceModule, // Required for ComprehensiveSummaryProcessor
    PromptResolutionServiceModule, // Required for prompt fallback chain
    NoteGenerationServiceModule, // seam — the generator decision for ConsultationEventHandler
    HarnessPolicyServiceModule, // TEXT-selection resolver for the pre-summary/comprehensive processors
    // the shared TEXT credential/profile enrichment. TEXT holds no
    // endpoint or credential of its own; without a `provider_overrides` entry it
    // fails closed with 503 PROVIDER_CREDENTIALS_MISSING.
    TextRequestServiceModule,
    ConfigResolverModule, // Realtime cascade + preferred-prompt threading (handler + pre-summary/comprehensive processors)
    UsageLedgerServiceModule, // usage emission for ComprehensiveSummaryProcessor
    // (finishing) — supplies `IGateEditExemplarRetriever` for the
    // `PromptAssemblyService` provided below. `PromptAssemblyService` injects it `@Optional()`,
    // so without this import it resolved to `undefined` and few-shot degraded to zero-shot with
    // no error, no log and every unit test green.
    //
    // The two live consumers here are `PreSummaryProcessor` (POST
    // `:id/summary/pre-summary/async`) and `ComprehensiveSummaryProcessor` (POST
    // `:id/summary/comprehensive/async`); both call `promptAssemblyService.assemble(...)`
    // directly.
    GateEditMiningServiceModule,
    EventEmitterModule, // Required for @OnEvent handlers and EventEmitter2 injection
    RedisCacheModule.register(), // For job status storage and pub/sub
    // `GenerateSummary`/`ExtractNamedEntities` (the legacy
    // signable-generator queues) were removed here along with
    // `SummaryProcessor`/`NerProcessor`. `GeneratePreSummary`/
    // `GenerateComprehensiveSummary` survive per the R-2 boundary (kept,
    // non-signable helper generators — see
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
