import { Module } from '@nestjs/common';
import { RedisCacheModule } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { HarnessProgressService } from './harness-progress.service';

/**
 * HarnessProgressService DI module (TASK-345 — live harness activity feed).
 *
 * Redis-only wiring (no Prisma — progress is ephemeral realtime data):
 * - RedisCacheModule        → publish/setex the folded state to `consultation:harness-progress:{id}`
 * - RedisSubscriberService  → dedicated subscriber connection for the SSE relay
 */
@Module({
  imports: [RedisCacheModule.register()],
  providers: [HarnessProgressService, RedisSubscriberService],
  exports: [HarnessProgressService],
})
export class HarnessProgressServiceModule {}
