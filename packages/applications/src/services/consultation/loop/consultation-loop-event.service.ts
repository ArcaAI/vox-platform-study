import { Inject, Injectable, Logger } from '@nestjs/common';
import { IRedisCacheService } from '../../baseServices/redis';
import type { HarnessLoopEventAck, HarnessLoopEventRequest, LoopEventDto } from './dto';

/**
 * ConsultationLoopEventService — publishes loop-workflow output for the live
 * client feed.
 *
 * Ephemeral, Redis-only (no Prisma) — mirrors `AgentTrajectoryService`'s
 * channel-prefix + publish shape (`republishToLiveView`), NOT the
 * snapshot/fold services (`HarnessProgressService` / `HarnessAssuranceService`):
 * the loop feed is append-only, so there is nothing to fold and no late-join
 * snapshot — same posture as `consultation:trajectory:{id}`.
 *
 * `publishEvent` is the internal-POST target
 * (`POST /internal/harness/consultations/:id/loop-event`, the future
 * `ConsultationLoopWorkflow` client — TASK-662); the SSE relay
 * (`ConsultationController.streamLoop`) subscribes to the SAME channel
 * directly via `RedisSubscriberService`, mirroring `streamTrajectory`.
 *
 * Best-effort by contract, like every other harness-internal publish path: a
 * Redis hiccup must never fail the loop, so this always acks
 * `{ ok: boolean }` instead of throwing.
 */
@Injectable()
export class ConsultationLoopEventService {
  private readonly logger = new Logger(ConsultationLoopEventService.name);

  private readonly CHANNEL_PREFIX = 'consultation:loop:';

  constructor(@Inject(IRedisCacheService) private readonly cacheService: IRedisCacheService) {}

  async publishEvent(consultationId: string, dto: HarnessLoopEventRequest): Promise<HarnessLoopEventAck> {
    try {
      const event: LoopEventDto = {
        consultationId,
        tenantId: dto.tenantId,
        runId: dto.runId,
        kind: dto.kind,
        label: dto.label,
        data: dto.data,
        publishedAt: new Date().toISOString(),
      };
      await this.cacheService.publish(this.channel(consultationId), JSON.stringify(event));
      this.logger.debug({ message: 'Loop event published', consultationId, kind: dto.kind });
      return { ok: true };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to publish loop event (best-effort — loop unaffected)',
        consultationId,
        kind: dto.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false };
    }
  }

  private channel(consultationId: string): string {
    return `${this.CHANNEL_PREFIX}${consultationId}`;
  }
}
