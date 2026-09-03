import { Module } from '@nestjs/common';
import { RedisCacheModule } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { HarnessLiveAssistService } from './harness-live-assist.service';

/**
 * HarnessLiveAssistService DI module — live clinician-assist feed.
 *
 * Redis-only wiring, mirroring `HarnessProgressServiceModule` exactly (the assist
 * feed is ephemeral realtime data, never persisted):
 * - RedisCacheModule → publish/setex the folded state to `consultation:live-assist:{id}`
 * - RedisSubscriberService → dedicated subscriber connection for the SSE relay
 */
@Module({
  imports: [RedisCacheModule.register()],
  providers: [HarnessLiveAssistService, RedisSubscriberService],
  exports: [HarnessLiveAssistService],
})
export class HarnessLiveAssistServiceModule {}
