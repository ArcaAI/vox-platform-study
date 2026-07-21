import { Inject, Injectable, Logger, type MessageEvent } from '@nestjs/common';
import { Observable, ReplaySubject, type Subscription, filter, interval, map, merge, takeWhile } from 'rxjs';
import { IRedisCacheService } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import {
  HARNESS_PROGRESS_FAILED_STAGE,
  HARNESS_PROGRESS_TERMINAL_STAGE,
  type HarnessProgressAck,
  type HarnessProgressEventDto,
  type HarnessProgressRequest,
  type HarnessProgressStageDto,
} from './dto';

/**
 * HarnessProgressService — live harness activity feed.
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
  // Hard ceiling on snapshot growth. The DTO's @IsIn already
  // rejects unknown stage keys at the HTTP edge; this cap is defense-in-depth
  // for any other caller of reportProgress. Matches the @Max(50) ordinal bound.
  private readonly MAX_STAGES = 50;

  constructor(
    @Inject(IRedisCacheService) private readonly cacheService: IRedisCacheService,
    private readonly redisSubscriber: RedisSubscriberService,
  ) {}

  /**
   * Fold one harness stage event into the accumulated state, store the snapshot,
   * and publish the full state. The workflow emits stages sequentially, but the
   * HTTP hops can re-order/duplicate deliveries (5s client timeout inside a 10s
   * activity), so `fold` applies a monotonic guard and may IGNORE an event
   * (returns null) — ignored events are still acked `{ ok: true }`.
   */
  async reportProgress(consultationId: string, dto: HarnessProgressRequest): Promise<HarnessProgressAck> {
    try {
      const prior = await this.loadSnapshot(consultationId);
      const next = this.fold(consultationId, prior, dto);
      if (!next) {
        this.logger.debug({ message: 'Harness progress event ignored (stale or out-of-bounds)', consultationId, stage: dto.stage });
        return { ok: true };
      }
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
   * SSE source for `GET /consultations/:id/harness-progress/stream`. Subscribes
   * to the Redis channel FIRST (buffering through a ReplaySubject), then emits
   * the stored snapshot (late-join) and relays the buffered + live channel
   * events — de-duped against the snapshot by `updatedAt` — until the terminal
   * `closed: true` event, with a periodic heartbeat so idle streams survive
   * proxies. Mirrors `LiveDocumentationService.subscribeToLiveSummary`.
   *
   * Subscribe-before-snapshot closes the window where an
   * event published between the snapshot read and the channel subscription
   * (including the terminal `closed`) was silently dropped.
   *
   * Channel teardown relies EXCLUSIVELY on the refcounted
   * finalize inside `RedisSubscriberService.subscribeToChannel`. An explicit
   * `unsubscribeFromChannel` here would force-complete the SHARED per-channel
   * Subject and starve every other concurrent viewer of the same consultation.
   */
  subscribeToProgress(consultationId: string): Observable<MessageEvent> {
    const channel = this.channel(consultationId);

    return new Observable<MessageEvent>((subscriber) => {
      let inner: Subscription | null = null;
      let bridgeSub: Subscription | null = null;

      (async () => {
        const messages$ = await this.redisSubscriber.subscribeToChannel(channel);
        // Buffer channel events while the snapshot read is in flight; replayed
        // into the relay below so ordering stays snapshot-first.
        const bridge = new ReplaySubject<string>();
        bridgeSub = messages$.subscribe(bridge);

        const snapshot = await this.cacheService.get(this.snapshotKey(consultationId));
        const snapshotUpdatedAt = this.parseUpdatedAt(snapshot);
        if (snapshot) {
          subscriber.next({ data: snapshot } as MessageEvent);
        }

        const relay$ = bridge.pipe(
          // De-dupe: reportProgress stores the snapshot BEFORE publishing, so a
          // buffered event can be the very state the snapshot already carried.
          filter((raw: string) => !this.isDuplicateOfSnapshot(raw, snapshotUpdatedAt)),
          map((raw: string): MessageEvent => ({ data: raw }) as MessageEvent),
        );

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
        );

        inner = stream$.subscribe({
          next: (event) => subscriber.next(event),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      })().catch((error) => {
        this.logger.error({
          message: 'Failed to initialise harness-progress SSE subscription',
          consultationId,
          error: error instanceof Error ? error.message : String(error),
        });
        subscriber.next({ data: JSON.stringify({ error: 'Failed to subscribe to harness progress', consultationId }) } as MessageEvent);
        subscriber.complete();
      });

      return () => {
        inner?.unsubscribe();
        // Releasing the bridge drives the refcounted channel cleanup (last
        // viewer out tears the Redis subscription down).
        bridgeSub?.unsubscribe();
      };
    });
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * Fold one stage event into the prior state:
   *   - different `jobId` than the prior snapshot → NEW run: prior discarded (MAJ-2)
   *   - terminal `completed` → every stage completed + `closed: true` (no new entry)
   *   - terminal `failed` → active stage marked `failed`, the rest frozen
   *     as-is (completed stay completed, pending stay pending) + `closed: true` (MAJ-1)
   *   - re-emission of the CURRENT active stage (regen) → re-activated, attempt incremented
   *   - new stage AFTER the active one → appended as active (advance)
   * Stages before the active one fold to completed; stages after reset to pending.
   *
   * Monotonic guard (MAJ-5 / MIN-2) — returns `null` (event IGNORED, nothing
   * stored or published) for:
   *   - any non-terminal event once the run closed (same jobId): the feed only
   *     reopens for a new run (new jobId);
   *   - an event whose effective ordinal is BELOW the current active stage's:
   *     the HTTP hop can deliver a slow stage-N request after stage N+1 folded,
   *     and a backward jump is indistinguishable from that stale re-delivery.
   *     The trade-off is explicit: a workflow regen pass re-entering an earlier
   *     stage is NOT re-activated — the regen surfaces when the active stage is
   *     re-emitted (attempt increments at/after the current active ordinal);
   *   - a NEW stage key once the snapshot already holds MAX_STAGES (MAJ-6).
   */
  private fold(consultationId: string, prior: HarnessProgressEventDto | null, dto: HarnessProgressRequest): HarnessProgressEventDto | null {
    const now = new Date().toISOString();
    // MAJ-2: a different jobId is a different harness run — never merge two
    // runs into one checklist (inherited stages + "pass 2" attempt lies).
    if (dto.jobId != null && prior?.jobId != null && dto.jobId !== prior.jobId) {
      prior = null;
    }
    const stages: HarnessProgressStageDto[] = (prior?.stages ?? []).map((stage) => ({ ...stage }));
    const tenantId = dto.tenantId ?? prior?.tenantId;
    const jobId = dto.jobId ?? prior?.jobId;
    const total = dto.total ?? prior?.total;

    if (dto.stage === HARNESS_PROGRESS_TERMINAL_STAGE) {
      for (const stage of stages) {
        stage.status = 'completed';
      }
      return { consultationId, tenantId, jobId, total, stages, updatedAt: now, closed: true };
    }

    if (dto.stage === HARNESS_PROGRESS_FAILED_STAGE) {
      // MAJ-1: freeze the picture at the failure point — only the stage that
      // was running flips to `failed`; nothing is retroactively completed.
      for (const stage of stages) {
        if (stage.status === 'active') {
          stage.status = 'failed';
        }
      }
      return { consultationId, tenantId, jobId, total, stages, updatedAt: now, closed: true };
    }

    // Closed run (same jobId): ignore late stage re-deliveries — only a new
    // jobId (handled above) starts a fresh feed.
    if (prior?.closed) {
      return null;
    }

    let active = stages.find((stage) => stage.stage === dto.stage);
    const currentActive = stages.find((stage) => stage.status === 'active');
    const effectiveOrdinal = dto.ordinal ?? active?.ordinal ?? stages.length + 1;
    if (currentActive && effectiveOrdinal < currentActive.ordinal) {
      return null; // stale re-delivery of an earlier stage — never rewind
    }

    if (active) {
      active.attempt += 1;
      active.at = now;
      if (dto.label) active.label = dto.label;
      if (dto.ordinal != null) active.ordinal = dto.ordinal;
    } else {
      if (stages.length >= this.MAX_STAGES) {
        return null; // MAJ-6: snapshot at capacity — drop unseen stage keys
      }
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

    return { consultationId, tenantId, jobId, total, stages, updatedAt: now, closed: false };
  }

  /** The `updatedAt` of a serialized snapshot; null when absent/corrupt. */
  private parseUpdatedAt(snapshot: string | null | undefined): string | null {
    if (!snapshot) return null;
    try {
      const updatedAt = (JSON.parse(snapshot) as Partial<HarnessProgressEventDto>).updatedAt;
      return typeof updatedAt === 'string' ? updatedAt : null;
    } catch {
      return null;
    }
  }

  /**
   * True when a relayed channel event carries state the just-emitted snapshot
   * already contained (same or older `updatedAt` — ISO strings compare
   * lexicographically). Events without an `updatedAt` (heartbeats never reach
   * this filter, but be permissive) are relayed untouched.
   */
  private isDuplicateOfSnapshot(raw: string, snapshotUpdatedAt: string | null): boolean {
    if (!snapshotUpdatedAt) return false;
    const updatedAt = this.parseUpdatedAt(raw);
    return updatedAt != null && updatedAt <= snapshotUpdatedAt;
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
