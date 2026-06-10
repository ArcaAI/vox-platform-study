import { Inject, Injectable, Logger, type MessageEvent } from '@nestjs/common';
import { Observable, type Subscription, finalize, interval, map, merge, takeWhile } from 'rxjs';
import { IRedisCacheService } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import {
  HARNESS_PROGRESS_TERMINAL_STAGE,
  type HarnessProgressAck,
  type HarnessProgressEventDto,
  type HarnessProgressRequest,
  type HarnessProgressStageDto,
} from './dto';

/**
 * HarnessProgressService (TASK-345 — live harness activity feed).
 *
 * Ephemeral, Redis-only (no Prisma): the durable harness workflow reports one
 * stage event at a time via the internal `/internal/harness/consultations/:id/progress`
 * endpoint; this service folds it into the accumulated full-state snapshot
 * (`consultation:harness-progress:{id}:last`, 1h TTL — late-join replay) and
 * publishes that full state on `consultation:harness-progress:{id}` for the
 * SSE relay. Keyed by consultationId (the id the UI always knows — the harness
 * jobId never reaches the browser), mirroring the live-summary channel.
 *
 * Best-effort by contract: progress must never break the workflow OR the
 * draft, so `reportProgress` resolves `{ ok: false }` on any Redis failure
 * instead of throwing. Payloads carry NO PHI (stage keys/labels/timestamps).
 */
@Injectable()
export class HarnessProgressService {
  private readonly logger = new Logger(HarnessProgressService.name);

  private readonly CHANNEL_PREFIX = 'consultation:harness-progress:';
  private readonly SNAPSHOT_TTL = 3600; // 1h — transient last-state for SSE late-join
  private readonly HEARTBEAT_MS = 15000; // keep idle streams alive through proxies (inferential pass can run minutes)

  constructor(
    @Inject(IRedisCacheService) private readonly cacheService: IRedisCacheService,
    private readonly redisSubscriber: RedisSubscriberService,
  ) {}

  /**
   * Fold one harness stage event into the accumulated state, store the snapshot,
   * and publish the full state. The workflow emits stages sequentially, so the
   * read-fold-write here never races itself.
   */
  async reportProgress(consultationId: string, dto: HarnessProgressRequest): Promise<HarnessProgressAck> {
    try {
      const prior = await this.loadSnapshot(consultationId);
      const next = this.fold(consultationId, prior, dto);
      const serialized = JSON.stringify(next);

      await this.cacheService.setex(this.snapshotKey(consultationId), this.SNAPSHOT_TTL, serialized);
      await this.cacheService.publish(this.channel(consultationId), serialized);

      this.logger.debug({ message: 'Harness progress published', consultationId, stage: dto.stage, closed: next.closed });
      return { ok: true };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to publish harness progress (best-effort — workflow unaffected)',
        consultationId,
        stage: dto.stage,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false };
    }
  }

  /**
   * SSE source for `GET /consultations/:id/harness-progress/stream`. Emits the
   * stored snapshot immediately (late-join), then relays the Redis channel until
   * the terminal `closed: true` event, with a periodic heartbeat so idle streams
   * survive proxies. Mirrors `LiveDocumentationService.subscribeToLiveSummary`.
   */
  subscribeToProgress(consultationId: string): Observable<MessageEvent> {
    const channel = this.channel(consultationId);

    return new Observable<MessageEvent>((subscriber) => {
      let inner: Subscription | null = null;

      this.cacheService
        .get(this.snapshotKey(consultationId))
        .then(async (snapshot) => {
          if (snapshot) {
            subscriber.next({ data: snapshot } as MessageEvent);
          }

          const messages$ = await this.redisSubscriber.subscribeToChannel(channel);

          const relay$ = messages$.pipe(map((raw: string): MessageEvent => ({ data: raw }) as MessageEvent));

          const heartbeat$ = interval(this.HEARTBEAT_MS).pipe(
            map((): MessageEvent => ({ data: JSON.stringify({ type: 'heartbeat', ts: new Date().toISOString() }) }) as MessageEvent),
          );

          // takeWhile sits on the MERGED stream (not just the relay) so the
          // terminal `closed` event completes the whole SSE stream — the
          // infinite heartbeat interval would otherwise keep `merge` alive.
          const stream$ = merge(relay$, heartbeat$).pipe(
            takeWhile((event: MessageEvent) => {
              try {
                return JSON.parse(event.data as string).closed !== true;
              } catch {
                return true;
              }
            }, true), // include the terminal `closed` event
            finalize(() => this.redisSubscriber.unsubscribeFromChannel(channel)),
          );

          inner = stream$.subscribe({
            next: (event) => subscriber.next(event),
            error: (err) => subscriber.error(err),
            complete: () => subscriber.complete(),
          });
        })
        .catch((error) => {
          this.logger.error({
            message: 'Failed to initialise harness-progress SSE subscription',
            consultationId,
            error: error instanceof Error ? error.message : String(error),
          });
          subscriber.next({ data: JSON.stringify({ error: 'Failed to subscribe to harness progress', consultationId }) } as MessageEvent);
          subscriber.complete();
        });

      return () => inner?.unsubscribe();
    });
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * Fold one stage event into the prior state:
   *   - terminal `completed` → every stage completed + `closed: true` (no new entry)
   *   - known stage re-emitted (regen) → re-activated, attempt incremented
   *   - new stage → appended as active
   * Stages before the active one fold to completed; stages after reset to pending.
   */
  private fold(consultationId: string, prior: HarnessProgressEventDto | null, dto: HarnessProgressRequest): HarnessProgressEventDto {
    const now = new Date().toISOString();
    const stages: HarnessProgressStageDto[] = (prior?.stages ?? []).map((stage) => ({ ...stage }));
    const jobId = dto.jobId ?? prior?.jobId;
    const total = dto.total ?? prior?.total;

    if (dto.stage === HARNESS_PROGRESS_TERMINAL_STAGE) {
      for (const stage of stages) {
        stage.status = 'completed';
      }
      return { consultationId, jobId, total, stages, updatedAt: now, closed: true };
    }

    let active = stages.find((stage) => stage.stage === dto.stage);
    if (active) {
      active.attempt += 1;
      active.at = now;
      if (dto.label) active.label = dto.label;
      if (dto.ordinal != null) active.ordinal = dto.ordinal;
    } else {
      active = {
        stage: dto.stage,
        label: dto.label ?? dto.stage,
        ordinal: dto.ordinal ?? stages.length + 1,
        status: 'active',
        attempt: 1,
        at: now,
      };
      stages.push(active);
    }

    stages.sort((a, b) => a.ordinal - b.ordinal);
    for (const stage of stages) {
      if (stage.stage === active.stage) {
        stage.status = 'active';
      } else if (stage.ordinal <= active.ordinal) {
        stage.status = 'completed';
      } else {
        stage.status = 'pending';
      }
    }

    return { consultationId, jobId, total, stages, updatedAt: now, closed: false };
  }

  /** Read + parse the stored snapshot; corrupt or missing → null (start fresh). */
  private async loadSnapshot(consultationId: string): Promise<HarnessProgressEventDto | null> {
    const raw = await this.cacheService.get(this.snapshotKey(consultationId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<HarnessProgressEventDto>;
      if (parsed && Array.isArray(parsed.stages)) {
        return parsed as HarnessProgressEventDto;
      }
    } catch {
      /* corrupt snapshot — treat as absent */
    }
    return null;
  }

  private channel(consultationId: string): string {
    return `${this.CHANNEL_PREFIX}${consultationId}`;
  }

  private snapshotKey(consultationId: string): string {
    return `${this.CHANNEL_PREFIX}${consultationId}:last`;
  }
}
