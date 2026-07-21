import { Module } from '@nestjs/common';
import { RedisCacheModule } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { HarnessAssuranceService } from './harness-assurance.service';

/**
 * HarnessAssuranceService DI module — live assurance feed.
 *
 * Redis-only wiring (no Prisma — assurance verdicts are ephemeral realtime data):
 * - RedisCacheModule        → publish/setex the accumulated state to `consultation:harness-assurance:{id}`
 * - RedisSubscriberService  → dedicated subscriber connection for the SSE relay
 */
@Module({
  imports: [RedisCacheModule.register()],
  providers: [HarnessAssuranceService, RedisSubscriberService],
  exports: [HarnessAssuranceService],
})
export class HarnessAssuranceServiceModule {}
