import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { RedisCacheModule } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { ConsultationJobService, IConsultationJobService } from './consultation-job.service';
import { HarnessGatewayServiceModule } from '../harness/harness-gateway.service.module';
import { PreSummaryProcessor } from './processors/pre-summary.processor';
import { ConsultationEventHandler } from '../events/consultation-event.handler';
import { PromptResolutionServiceModule } from '../prompt/prompt-resolution.service.module';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { ObservabilityModule } from '../../baseServices/observability/observability.module';
import { HarnessPolicyServiceModule } from '../../harness-policy/harness-policy.service.module';
import { ConfigResolverModule } from '../../config-resolver';
import { NoteGenerationServiceModule } from '../note-generation/note-generation.service.module';
import { GateEditMiningServiceModule } from '../../gate-edit-mining/gate-edit-mining.service.module';
import { TextRequestServiceModule } from '../../text-request/text-request.service.module';
import { VisitTypeServiceModule } from '../visit-type/visit-type.service.module';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { ConsultationWorkflowDispatchServiceModule } from '../workflow-dispatch/consultation-workflow-dispatch.service.module';
import { TenantLockModule } from '../../tenant-checkpoint/lock/tenant-lock.module';
import { ConsultationLifecycleGateModule } from '../lifecycle/lifecycle.module';
import { ContextMedicalJudgeServiceModule } from '../../guardrail-context-judge/context-medical-judge.service.module';

@Module({
  imports: [
    // The processing axis for the auto-pipeline handler.
    ConsultationLifecycleGateModule,
    TenantLockModule,
    VisitTypeServiceModule,
    ConfigModule,
    HttpModule,
    CoreDatabaseModule,
    ObservabilityModule,
    PromptResolutionServiceModule, // Required for prompt fallback chain
    NoteGenerationServiceModule, // seam — the generator decision for ConsultationEventHandler
    HarnessPolicyServiceModule, // TEXT-selection resolver for the pre-summary processor
    // the shared TEXT credential/profile enrichment. TEXT holds no
    // endpoint or credential of its own; without a `provider_overrides` entry it
    // fails closed with 503 PROVIDER_CREDENTIALS_MISSING.
    TextRequestServiceModule,
    ConfigResolverModule, // Realtime cascade + preferred-prompt threading (handler + pre-summary processor)
    // (finishing) — supplies `IGateEditExemplarRetriever` for the
    // `PromptAssemblyService` provided below. `PromptAssemblyService` injects it `@Optional()`,
    // so without this import it resolved to `undefined` and few-shot degraded to zero-shot with
    // no error, no log and every unit test green.
    //
    // The one live consumer here is `PreSummaryProcessor` (POST
    // `:id/summary/pre-summary/async`), which calls `promptAssemblyService.assemble(...)`
    // directly. (`ComprehensiveSummaryProcessor` was a second consumer until TASK-1006 —
    // the comprehensive summary now runs synchronously on the agent plane and assembles
    // no prompt of its own.)
    GateEditMiningServiceModule,
    // TASK-1001 (OD-12) — supplies `EffectiveSettingsService`, through which the processor resolves
    // `consultation.summary.outputLanguage`, the platform-default language the note is WRITTEN in.
    // It injects it `@Optional()`, so without this import the job would still write English (the
    // code default) and a platform admin's write would be silently dead on this path.
    EffectiveSettingsModule,
    // TASK-1022 L-RESUME — supplies `IConsultationWorkflowDispatchService`, through which
    // `ConsultationEventHandler` re-finalises a GOVERNED consultation's resumed recording by
    // superseding its governing run. Injected `@Optional()`; without it a governed resume is
    // reported as not re-finalised (never handed to the default engine). No cycle: the dispatch
    // module's imports reach neither this module nor the harness-internal one.
    ConsultationWorkflowDispatchServiceModule,
    // TASK-1059 C-0 — the runtime context medical judge the pre-summary processor runs before it
    // assembles the prompt (a leaf module: no cycle).
    ContextMedicalJudgeServiceModule,
    EventEmitterModule, // Required for @OnEvent handlers and EventEmitter2 injection
    RedisCacheModule.register(), // For job status storage and pub/sub
    // TASK-1038 B3a (G14) — `HarnessGatewayService.cancelDocumentWorkflow` cancels a SUMMARY job.
    HarnessGatewayServiceModule,
    // `GenerateSummary`/`ExtractNamedEntities` (the legacy
    // signable-generator queues) were removed here along with
    // `SummaryProcessor`/`NerProcessor`. `GeneratePreSummary` survives per the R-2
    // boundary (kept, non-signable helper generator — see
    // `GenerateComprehensiveSummary`/`ComprehensiveSummaryProcessor` were removed by
    // TASK-1006 — the comprehensive summary now runs synchronously on the agent plane.
    BullModule.registerQueue({ name: JobQueue.GeneratePreSummary }),
  ],
  providers: [
    RedisSubscriberService, // Dedicated Redis subscriber for SSE pub/sub
    {
      provide: IConsultationJobService,
      useClass: ConsultationJobService,
    },
    PromptAssemblyService,
    PreSummaryProcessor,
    ConsultationEventHandler, // Auto-pipeline event handler
  ],
  exports: [IConsultationJobService, ConsultationEventHandler],
})
export class ConsultationJobServiceModule {}
