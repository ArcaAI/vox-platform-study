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
import { HarnessPolicyServiceModule } from '../../harness-policy/harness-policy.service.module';
import { AgentTrajectoryServiceModule } from '../../agent-trajectory/agent-trajectory.service.module';

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
 * TASK-344 (Workstream A2) — also hosts {@link OcrEnrichmentProcessor}, the
 * event-driven heavy-OCR enrichment handler. It shares this module's
 * `ContextAdded` reaction wiring and DI (HttpModule → NLP `/extract`,
 * CoreDatabaseModule → ContextItemRepository, EventEmitterModule → re-emit;
 * IBlobStorageService + ClsService are global), so no new module is needed.
 */
@Module({
  // TASK-510 §2C/§2D — AgentTrajectoryServiceModule resolves the @Optional
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
  ],
  providers: [LiveDocumentationService, RedisSubscriberService, OcrEnrichmentProcessor],
  exports: [LiveDocumentationService],
})
export class LiveDocumentationServiceModule {}
