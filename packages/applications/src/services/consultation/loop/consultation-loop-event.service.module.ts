import { Module } from '@nestjs/common';
import { RedisCacheModule } from '../../baseServices/redis';
import { ConsultationLoopEventService } from './consultation-loop-event.service';

/**
 * ConsultationLoopEventService DI module — live loop-output feed.
 *
 * Redis-only wiring (no Prisma — the loop feed is ephemeral realtime data,
 * mirroring `HarnessProgressServiceModule`): `RedisCacheModule` → publish to
 * `consultation:loop:{id}`. The SSE relay reuses `ConsultationModule`'s own
 * `RedisSubscriberService` provider (see `consultation.module.ts`) rather
 * than a dedicated one here — no new subscriber connection is needed.
 */
@Module({
  imports: [RedisCacheModule.register()],
  providers: [ConsultationLoopEventService],
  exports: [ConsultationLoopEventService],
})
export class ConsultationLoopEventServiceModule {}
