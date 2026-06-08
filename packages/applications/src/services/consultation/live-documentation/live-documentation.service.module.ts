import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CoreDatabaseModule } from '@arcaai/domains';
import { RedisCacheModule } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { StreamingSessionServiceModule } from '../../stt/streaming/streamingSession.service.module';
import { LiveDocumentationService } from './live-documentation.service';

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
 */
@Module({
  imports: [HttpModule, ConfigModule, CoreDatabaseModule, EventEmitterModule, RedisCacheModule.register(), StreamingSessionServiceModule],
  providers: [LiveDocumentationService, RedisSubscriberService],
  exports: [LiveDocumentationService],
})
export class LiveDocumentationServiceModule {}
