import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { RedisCacheModule } from '../../baseServices/redis/redis-cache.module';
import { TranscriptionJobServiceModule } from '../job/transcriptionJob.service.module';
import { RedisSubscriberService } from './redisSubscriber.service';
import { TranscriptionRealtimeService } from './transcriptionRealtime.service';

/**
 * Transcription Realtime Service Module
 *
 * Provides real-time transcription streaming via Redis Pub/Sub + SSE.
 *
 * Imports:
 * - CoreDatabaseModule: Database access for job creation
 * - EventEmitterModule: Domain event emission
 * - ClsModule: Request context (tenantId, userId)
 * - RedisCacheModule: Redis publish + Dramatiq dispatch
 * - TranscriptionJobServiceModule: Job CRUD operations
 *
 * Providers:
 * - RedisSubscriberService: Dedicated ioredis subscriber connection
 * - TranscriptionRealtimeService: Orchestrates job creation, dispatch, SSE
 */
@Module({
  imports: [CoreDatabaseModule, EventEmitterModule, ClsModule, RedisCacheModule.register(), TranscriptionJobServiceModule],
  providers: [RedisSubscriberService, TranscriptionRealtimeService],
  exports: [TranscriptionRealtimeService, RedisSubscriberService],
})
export class TranscriptionRealtimeServiceModule {}
