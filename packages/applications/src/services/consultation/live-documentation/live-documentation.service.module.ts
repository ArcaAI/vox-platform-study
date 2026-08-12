import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CoreDatabaseModule } from '@arcaai/domains';
import { RedisCacheModule } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { StreamingSessionServiceModule } from '../../stt/streaming/streamingSession.service.module';
import { LiveDocumentationService } from './live-documentation.service';
import { OcrEnrichmentProcessor } from '../ocr/ocr-enrichment.processor';
import { LoopContextSignalService } from '../loop/loop-context-signal.service';
import { HarnessGatewayServiceModule } from '../harness/harness-gateway.service.module';
import { HarnessPolicyServiceModule } from '../../harness-policy/harness-policy.service.module';
import { AgentTrajectoryServiceModule } from '../../agent-trajectory/agent-trajectory.service.module';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { AiTaskDefaultServiceModule } from '../../ai-task-default/ai-task-default.service.module';
import { LiveAgentResolutionServiceModule } from '../prompt/live-agent-resolution.service.module';

/**
 * Live Documentation Service Module (Clinical Workflow Playground — WS1).
 *
 * Wires the per-consultation realtime watcher:
 * - HttpModule         → SMR (`/api/v1/generate`) + NLP (`/api/v1/classify/tokens`) calls
 * - ConfigModule       → service URLs + debounce tuning (NLP_URL, SMR_URL, LIVE_DOC_*)
 * - CoreDatabaseModule → ContextItemRepository for the optional PRE_SUMMARY snapshot on stop
 * - EventEmitterModule → @OnEvent(ConsultationPipelineEvent.ContextAdded) reaction
 * - RedisCacheModule   → publish/setex the running summary to `consultation:live-summary:{id}`
 * - RedisSubscriberService → dedicated subscriber connection for the SSE relay
 * - StreamingSessionServiceModule → StreamingAudioBridgeService for `stt:result:{sessionId}`
 *
 * Also hosts {@link OcrEnrichmentProcessor}, the
 * event-driven heavy-OCR enrichment handler. It shares this module's
 * `ContextAdded` reaction wiring and DI (HttpModule → NLP `/extract`,
 * CoreDatabaseModule → ContextItemRepository, EventEmitterModule → re-emit;
 * IBlobStorageService + ClsService are global), so no new module is needed.
 *
 * TASK-660 — also hosts {@link LoopContextSignalService}, the third
 * `@OnEvent(ContextAdded)` consumer that signals the (future) consultation
 * loop workflow. Added the same way OcrEnrichmentProcessor was: a new
 * provider in THIS module, no controller or route change. It additionally
 * needs `HarnessGatewayServiceModule` for the outbound harness signal call.
 *
 * TASK-670 — {@link LoopContextSignalService} is now also EXPORTED: it grew
 * `signalConsultationEnding`/`signalLoopCancel`, called directly from
 * `ConsultationController.stopRecording` (a real consumer outside this
 * module, unlike the `@OnEvent` wiring, which stays internal).
 */
@Module({
  // §2C/§2D — AgentTrajectoryServiceModule resolves the @Optional
  // IAgentTrajectoryService emitter dep so the per-flush trajectory goes live.
  imports: [
    HttpModule,
    ConfigModule,
    CoreDatabaseModule,
    EventEmitterModule,
    RedisCacheModule.register(),
    StreamingSessionServiceModule,
    HarnessPolicyServiceModule,
    AgentTrajectoryServiceModule,
    // EffectiveSettingsModule resolves the @Optional
    // EffectiveSettingsService so `agentic.context.*` is governed by the control
    // plane's settings registry rather than by constructor-frozen env values.
    EffectiveSettingsModule,
    // nlp.ner model-injection resolver for the live-plane NLP call (TASK-552 Lane A).
    AiTaskDefaultServiceModule,
    // TASK-635 C3 — resolves the @Optional ILiveAgentResolver port so a session
    // freezes its governed agent (prompt bytes + tool plan + LLM override) at
    // start(). Absent ⇒ the service falls open to the in-code constants.
    LiveAgentResolutionServiceModule,
    // TASK-660 — outbound apps/api -> apps/harness adapter LoopContextSignalService signals through.
    HarnessGatewayServiceModule,
  ],
  providers: [LiveDocumentationService, RedisSubscriberService, OcrEnrichmentProcessor, LoopContextSignalService],
  exports: [LiveDocumentationService, LoopContextSignalService],
})
export class LiveDocumentationServiceModule {}
