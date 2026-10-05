import { Inject, Injectable, Logger, Optional, type MessageEvent } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import type { Observable } from 'rxjs';
import type { ConsultationClosedReason, ConsultationProcessing, ConsultationStatus, LifecycleEvent, LifecycleEventType } from '@arcaai/types';
import { ResourceType, SysEventType } from '@arcaai/domains';
import { BaseService } from '../../../common';
import { sseFromRedisChannel } from '../../../common/sse/redis-channel-sse';
import { IActiveUserContext } from '../../../interfaces';
import { IRedisCacheService } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { ConsultationPipelineEvent, type LifecycleChangedPayload } from '../events/consultation.events';

/** The replay buffer behind `GET consultations/:id/events?since=` holds this many frames. */
export const LIFECYCLE_REPLAY_SIZE = 50;

/**
 * How long the replay buffer and the seq counter outlive the last event. Refreshed on every
 * publish; a consultation silent for longer restarts its seq at 1, and a client then re-reads
 * the consultation instead of replaying.
 */
const LIFECYCLE_BUFFER_TTL_SECONDS = 30 * 24 * 60 * 60;

/** SSE keep-alive period for the lifecycle stream. */
const LIFECYCLE_SSE_HEARTBEAT_MS = 15_000;

export function lifecycleChannel(consultationId: string): string {
  return `consultation:lifecycle:${consultationId}`;
}

function replayKey(consultationId: string): string {
  return `${lifecycleChannel(consultationId)}:replay`;
}

function seqKey(consultationId: string): string {
  return `${lifecycleChannel(consultationId)}:seq`;
}

/**
 * Append + trim + refresh TTLs + publish, atomically, so a subscriber that replays from the
 * buffer and then listens cannot miss a frame between the two. KEYS: replay list, seq counter.
 * ARGV: frame, -size, ttl, channel.
 */
const PUBLISH_SCRIPT = `
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
redis.call('PUBLISH', ARGV[4], ARGV[1])
return 1
`;

const REPLAY_SCRIPT = `return redis.call('LRANGE', KEYS[1], 0, -1)`;

/** The consultation fields a lifecycle frame reports. */
export interface LifecycleSubject {
  id: string;
  tenantId: string;
  status: string;
  processing: string;
  processingReason?: string | null;
  closedReason?: string | null;
  currentEncounterSeq: number;
  version: number;
}

/**
 * Emits one lifecycle change on its three paths:
 *
 * 1. in-process — `ConsultationPipelineEvent.LifecycleChanged` (EventEmitter2);
 * 2. connected clients — a frame on Redis `consultation:lifecycle:{id}` plus a
 *    {@link LIFECYCLE_REPLAY_SIZE}-entry replay buffer for `?since=`;
 * 3. unconnected consumers — the sys-event `ResourceUpdated` (resourceType `Consultation`,
 *    `data.action = 'lifecycle'`, `data.event`), which feeds the audit log and the webhook fan-out.
 *
 * Best-effort by contract: the lifecycle command has already committed when this runs, so a Redis
 * failure is logged and never raised. The frame carries state only — no content, no PHI.
 */
@Injectable()
export class ConsultationLifecycleEventPublisher extends BaseService {
  private readonly logger = new Logger(ConsultationLifecycleEventPublisher.name);

  constructor(
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(IRedisCacheService) private readonly cache?: Pick<IRedisCacheService, 'incr' | 'eval'>,
    @Optional() private readonly redisSubscriber?: RedisSubscriberService,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  async publish(subject: LifecycleSubject, type: LifecycleEventType, extras: { encounterSeq?: number; userId?: string } = {}): Promise<LifecycleEvent> {
    const event: LifecycleEvent = {
      type,
      consultationId: subject.id,
      status: subject.status as ConsultationStatus,
      processing: subject.processing as ConsultationProcessing,
      ...(subject.processingReason ? { processingReason: subject.processingReason } : {}),
      ...(subject.closedReason ? { closedReason: subject.closedReason as ConsultationClosedReason } : {}),
      encounterSeq: extras.encounterSeq ?? subject.currentEncounterSeq,
      version: subject.version,
      at: new Date().toISOString(),
      seq: await this.nextSeq(subject.id),
    };

    if (event.seq > 0) {
      await this.pushFrame(subject.id, event);
    }

    try {
      const payload: LifecycleChangedPayload = {
        consultationId: subject.id,
        tenantId: subject.tenantId,
        userId: extras.userId ?? this.requestUserId ?? undefined,
        timestamp: event.at,
        event,
      };
      this.eventEmitter.emit(ConsultationPipelineEvent.LifecycleChanged, payload);

      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: subject.id,
        resourceType: ResourceType.Consultation,
        data: {
          action: 'lifecycle',
          event: type,
          status: event.status,
          processing: event.processing,
          ...(event.closedReason ? { closedReason: event.closedReason } : {}),
          encounterSeq: event.encounterSeq,
          version: event.version,
          seq: event.seq,
        },
      });
    } catch (error) {
      this.logger.warn({
        message: 'Lifecycle event fan-out failed (best-effort, the change stands)',
        consultationId: subject.id,
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return event;
  }

  /** Buffered frames with `seq > since` (all of them when `since` is absent), oldest first. */
  async replay(consultationId: string, since?: number): Promise<LifecycleEvent[]> {
    if (!this.cache) return [];
    let raw: unknown;
    try {
      raw = await this.cache.eval(REPLAY_SCRIPT, 1, replayKey(consultationId));
    } catch (error) {
      this.logger.warn({
        message: 'Lifecycle replay buffer unreadable — replaying nothing',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    const frames = (Array.isArray(raw) ? raw : []).flatMap((entry) => {
      try {
        return [JSON.parse(String(entry)) as LifecycleEvent];
      } catch {
        return [];
      }
    });
    return frames.filter((frame) => since === undefined || frame.seq > since).sort((a, b) => a.seq - b.seq);
  }

  /**
   * The SSE relay `GET consultations/:id/events?since=` serves: the buffered frames newer than
   * `since` first, then live frames, with any live frame the replay already delivered dropped.
   * The caller asserts tenancy before subscribing.
   */
  subscribe(consultationId: string, since?: number): Observable<MessageEvent> {
    if (!this.redisSubscriber) {
      throw new Error('Lifecycle event stream unavailable: no Redis subscriber is wired');
    }
    let replayedUpTo = since ?? 0;
    return sseFromRedisChannel(this.redisSubscriber, this.logger, {
      channel: lifecycleChannel(consultationId),
      heartbeatMs: LIFECYCLE_SSE_HEARTBEAT_MS,
      loadSnapshot: async () => {
        const frames = await this.replay(consultationId, since);
        if (frames.length > 0) replayedUpTo = frames[frames.length - 1].seq;
        return frames.map((frame) => JSON.stringify(frame));
      },
      isDuplicateOfSnapshot: (raw) => {
        try {
          return (JSON.parse(raw) as LifecycleEvent).seq <= replayedUpTo;
        } catch {
          return false;
        }
      },
      setupErrorPayload: JSON.stringify({ type: 'error', consultationId, message: 'Lifecycle event stream could not be opened' }),
      logContext: { consultationId },
    });
  }

  private async nextSeq(consultationId: string): Promise<number> {
    if (!this.cache) return 0;
    try {
      return await this.cache.incr(seqKey(consultationId));
    } catch (error) {
      this.logger.warn({
        message: 'Lifecycle seq counter unavailable — frame not buffered or published',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private async pushFrame(consultationId: string, event: LifecycleEvent): Promise<void> {
    try {
      await this.cache!.eval(
        PUBLISH_SCRIPT,
        2,
        replayKey(consultationId),
        seqKey(consultationId),
        JSON.stringify(event),
        -LIFECYCLE_REPLAY_SIZE,
        LIFECYCLE_BUFFER_TTL_SECONDS,
        lifecycleChannel(consultationId),
      );
    } catch (error) {
      this.logger.warn({
        message: 'Lifecycle frame not published (best-effort, the change stands)',
        consultationId,
        type: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
