import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CoreDatabaseModule } from '@arcaai/domains';
import { AgentServiceModule } from '../../agent/agent.service.module';
import { RedisCacheModule } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { StreamingSessionServiceModule } from '../../stt/streaming/streamingSession.service.module';
import { LiveDocumentationService } from './live-documentation.service';
import { OcrEnrichmentProcessor } from '../ocr/ocr-enrichment.processor';
import { LoopContextSignalService } from '../loop/loop-context-signal.service';
import { HarnessGatewayServiceModule } from '../harness/harness-gateway.service.module';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';
import { HarnessPolicyServiceModule } from '../../harness-policy/harness-policy.service.module';
import { AgentTrajectoryServiceModule } from '../../agent-trajectory/agent-trajectory.service.module';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { AiRoutingPolicyServiceModule } from '../../ai-routing-policy/ai-routing-policy.service.module';
import { LiveAgentResolutionServiceModule } from '../prompt/live-agent-resolution.service.module';
import { TextRequestServiceModule } from '../../text-request/text-request.service.module';
import { DocumentTemplateServiceModule } from '../../document-template/document-template.service.module';
import { WorkflowAssignmentServiceModule } from '../../workflow-assignment/workflow-assignment.service.module';
import { HarnessLiveAssistServiceModule } from '../harness/harness-live-assist.service.module';
import { UsageLedgerServiceModule } from '../../usageLedger/usage-ledger.service.module';
import { LivePreSummaryModule } from '../summary/live-pre-summary.module';
import { ConfigResolverModule } from '../../config-resolver/config-resolver.module';

/**
 * Live Documentation Service Module (Clinical Workflow Playground — WS1).
 *
 * Wires the per-consultation realtime watcher:
 * - HttpModule → TEXT (`/api/v1/generate`) + NLP (`/api/v1/classify/tokens`) calls
 * - ConfigModule → service URLs + debounce tuning (NLP_URL, TEXT_URL, LIVE_DOC_*)
 * - CoreDatabaseModule → ContextItemRepository for the optional PRE_SUMMARY snapshot on stop
 * - EventEmitterModule → @OnEvent(ConsultationPipelineEvent.ContextAdded) reaction
 * - RedisCacheModule → publish/setex the running summary to `consultation:live-summary:{id}`
 * - RedisSubscriberService → dedicated subscriber connection for the SSE relay
 * - StreamingSessionServiceModule → StreamingAudioBridgeService for `stt:result:{sessionId}`
 *
 * Also hosts {@link OcrEnrichmentProcessor}, the
 * event-driven heavy-OCR enrichment handler. It shares this module's
 * `ContextAdded` reaction wiring and DI (HttpModule → NLP `/extract`,
 * CoreDatabaseModule → ContextItemRepository, EventEmitterModule → re-emit;
 * IBlobStorageService + ClsService are global), so no new module is needed.
 *
 * Also hosts {@link LoopContextSignalService}, the third
 * `@OnEvent(ContextAdded)` consumer that signals the (future) consultation
 * loop workflow. Added the same way OcrEnrichmentProcessor was: a new
 * provider in THIS module, no controller or route change. It additionally
 * needs `HarnessGatewayServiceModule` for the outbound harness signal call.
 *
 * {@link LoopContextSignalService} is now also EXPORTED: it grew
 * `signalConsultationEnding`/`signalLoopCancel`, called directly from
 * `ConsultationController.stopRecording` (a real consumer outside this
 * module, unlike the `@OnEvent` wiring, which stays internal).
 */
@Module({
  // AgentTrajectoryServiceModule resolves the @Optional
  // IAgentTrajectoryService emitter dep so the per-flush trajectory goes live.
  imports: [
    HttpModule,
    ConfigModule,
    CoreDatabaseModule,
    EventEmitterModule,
    RedisCacheModule.register(),
    StreamingSessionServiceModule,
    HarnessPolicyServiceModule,
    // the shared TEXT credential/profile enrichment. TEXT holds no
    // endpoint or credential of its own; without a `provider_overrides` entry it
    // fails closed with 503 PROVIDER_CREDENTIALS_MISSING.
    TextRequestServiceModule,
    AgentTrajectoryServiceModule,
    // EffectiveSettingsModule resolves the @Optional
    // EffectiveSettingsService so `agentic.context.*` is governed by the control
    // plane's settings registry rather than by constructor-frozen env values.
    EffectiveSettingsModule,
    // nlp.ner routing election for the live-plane NLP call (`resolveNerModelInjection`).
    AiRoutingPolicyServiceModule,
    // Resolves the @Optional ILiveAgentResolver port so a session
    // freezes its governed agent (prompt bytes + tool plan + LLM override) at
    // start(). Absent ⇒ the service falls open to the in-code constants.
    LiveAgentResolutionServiceModule,
    // Outbound apps/api -> apps/harness adapter LoopContextSignalService signals through.
    HarnessGatewayServiceModule,
    // resolves the @Optional IEntitlementsService that decides loop
    // ELIGIBILITY. The harness agentic loop is packaged as a subscription
    // feature (`agenticLoop`), so `LoopContextSignalService` asks the tenant's
    // plan before every signal. Absent ⇒ the gate fails CLOSED, which is why
    // this import is not optional in practice even though the dep is.
    EntitlementsServiceModule,
    // resolves the @Optional IDocumentTemplateService so a session
    // FREEZES the tenant's pinned document shape at start(). Absent ⇒ every
    // session serves the compiled platform shape, which is behaviour equivalent
    // to the hardcoded four-section format this ticket replaced.
    DocumentTemplateServiceModule,
    // resolves the @Optional IWorkflowAssignmentService the realtime
    // LANE resolution needs (assignment cascade -> definition slug). The
    // definition repository, the consultation row the SUBSTRATE GATE reads and
    // the DocumentSectionRepository all come from CoreDatabaseModule above.
    // Absent ⇒ every session serves PLATFORM_REALTIME_LANE, which encodes
    // today's behaviour.
    WorkflowAssignmentServiceModule,
    // Lane R (R1) — resolves the @Optional HarnessLiveAssistService the realtime GRAMMAR pass
    // publishes its proposals through. The same channel and the same two-branch fold the durable
    // correction node already uses; absent ⇒ proposals are computed and returned on the node's
    // output but nothing reaches the clinician's assist feed.
    HarnessLiveAssistServiceModule,
    // TASK-890 §3.13 (OD-E) — resolves the @Optional IUsageLedgerService so this lane's TEXT
    // calls are RECORDED. Until this ticket the realtime lane posted to `apps/text` directly and
    // produced no ledger rows at all: a production LLM path that billed nothing. The quota half
    // (`IEntitlementsService`) already resolves through `EntitlementsServiceModule` above.
    UsageLedgerServiceModule,
    // TASK-930 (G-1) — supplies `AgentResolverService`, which turns a `core.agent` node's SLUG
    // into the agent's TASK and so decides which realtime capability the node runs. It also
    // supplies `TextAgentResolverService`, the TASK-876 injection this module named nowhere:
    // `HarnessPolicyServiceModule` imports `AgentServiceModule` but does not re-export it, so
    // neither resolver was reachable from this injector. Both deps are @Optional, so this is
    // additive — a composition without it keeps the pre-TASK-930 TEXT_GENERATION fallback.
    AgentServiceModule,
    // TASK-932 D-9 — resolves the @Optional `ILivePreSummaryRunner` the WARM START runs through.
    // One provider wide on purpose: the live path needs exactly one capability from the summary
    // pipeline, and importing `SummaryServiceModule` wholesale would make every future dependency
    // of `SummaryService` a dependency of the live flush path too. Absent ⇒ a graph that declares
    // an `onStart` node publishes `degraded: warm_start_unwired`, which is observable rather than
    // silent.
    LivePreSummaryModule,
    // TASK-932 R-16a — supplies `ConfigResolver`, which answers the tenant AND doctor DNA gate
    // the LIVE HANDOFF respects before it hands the clinician's writing style to the durable
    // finalizer. The report repository itself comes from `CoreDatabaseModule` above. Absent ⇒
    // the handoff carries no style and the note finalizes in plain clinical prose.
    ConfigResolverModule,
  ],
  providers: [LiveDocumentationService, RedisSubscriberService, OcrEnrichmentProcessor, LoopContextSignalService],
  exports: [LiveDocumentationService, LoopContextSignalService],
})
export class LiveDocumentationServiceModule {}
