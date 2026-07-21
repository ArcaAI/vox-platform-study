import { Inject, Injectable, Logger, type MessageEvent } from '@nestjs/common';
import { Observable, ReplaySubject, type Subscription, filter, interval, map, merge, takeWhile } from 'rxjs';
import { IRedisCacheService } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import type {
  HarnessAssuranceAck,
  HarnessAssuranceClaimDto,
  HarnessAssuranceEventDto,
  HarnessAssuranceEventRequest,
} from './dto';

/**
 * Terminal-verdict payload published by {@link HarnessInternalService.finalizeAssurance}
 * once the optimistic assurance pass settles. Closes the SSE feed.
 */
export interface HarnessAssuranceCompletePayload {
  tenantId?: string;
  jobId?: string;
  gateDecision?: string | null;
  safetyFlag?: boolean;
  reducedAssurance?: boolean;
  /** An adverse verdict landed AFTER an early sign (amendment alert). */
  postSignAlert?: boolean;
}

/**
 * HarnessAssuranceService — true mid-pass live assurance feed.
 *
 * Ephemeral, Redis-only (no Prisma), keyed by consultationId. Two producers feed
 * the same accumulated snapshot:
 *   - the harness `run_inferential_sensors` activity calls `reportClaim` AS EACH
 *     claim verdict resolves (true-live, via the internal
 *     `/internal/harness/consultations/:id/assurance-event` route);
 *   - `finalizeAssurance` calls `publishComplete` with the aggregate verdict,
 *     which closes the feed (`closed: true`).
 * `subscribeToAssurance` relays the full state to the browser SSE route. Carries
 * NO PHI (claim ids, sensor keys, verdict labels only). Best-effort by contract:
 * a Redis hiccup must never break the workflow or the draft, so the publish paths
 * resolve `{ ok: false }` instead of throwing. Mirrors `HarnessProgressService`.
 */
@Injectable()
export class HarnessAssuranceService {
  private readonly logger = new Logger(HarnessAssuranceService.name);

  private readonly CHANNEL_PREFIX = 'consultation:harness-assurance:';
  private readonly SNAPSHOT_TTL = 3600; // 1h — transient last-state for SSE late-join
  private readonly HEARTBEAT_MS = 15000; // keep idle streams alive through proxies (the pass runs minutes)
  private readonly MAX_CLAIMS = 1000; // defense-in-depth ceiling on snapshot growth

  constructor(
    @Inject(IRedisCacheService) private readonly cacheService: IRedisCacheService,
    private readonly redisSubscriber: RedisSubscriberService,
  ) {}

  /**
   * Fold one resolved claim verdict into the accumulated snapshot and publish the
   * full state. De-dupes by claimId (a retried verdict updates in place). Ignored
   * once the feed is closed (a late claim after `assurance_complete`).
   */
  async reportClaim(consultationId: string, dto: HarnessAssuranceEventRequest): Promise<HarnessAssuranceAck> {
    try {
      const prior = await this.loadSnapshot(consultationId);
      const next = this.foldClaim(consultationId, prior, dto);
      if (!next) {
        this.logger.debug({ message: 'Harness assurance claim ignored (closed feed)', consultationId, claimId: dto.claimId });
        return { ok: true };
      }
      await this.persistAndPublish(consultationId, next);
      this.logger.debug({ message: 'Harness assurance claim published', consultationId, claimId: dto.claimId, sensor: dto.sensor });
      return { ok: true };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to publish harness assurance claim (best-effort — workflow unaffected)',
        consultationId,
        claimId: dto.claimId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false };
    }
  }

  /**
   * Publish the terminal `assurance_complete` event (aggregate verdict) and close
   * the feed. Folds onto whatever per-claim state accumulated so late joiners get
   * the full picture in one snapshot.
   */
  async publishComplete(consultationId: string, payload: HarnessAssuranceCompletePayload): Promise<HarnessAssuranceAck> {
    try {
      const prior = await this.loadSnapshot(consultationId);
      const now = new Date().toISOString();
      const next: HarnessAssuranceEventDto = {
        consultationId,
        tenantId: payload.tenantId ?? prior?.tenantId,
        jobId: payload.jobId ?? prior?.jobId,
        total: prior?.total,
        claims: prior?.claims ?? [],
        gateDecision: payload.gateDecision ?? null,
        safetyFlag: payload.safetyFlag ?? false,
        reducedAssurance: payload.reducedAssurance ?? false,
        postSignAlert: payload.postSignAlert ?? false,
        updatedAt: now,
        closed: true,
      };
      await this.persistAndPublish(consultationId, next);
      this.logger.debug({
        message: 'Harness assurance complete published',
        consultationId,
        gateDecision: next.gateDecision,
        postSignAlert: next.postSignAlert,
      });
      return { ok: true };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to publish harness assurance completion (best-effort — workflow unaffected)',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false };
    }
  }

  /**
   * SSE source for `GET /consultations/:id/harness-assurance/stream`. Subscribes
   * to the Redis channel FIRST (buffering through a ReplaySubject), emits the
   * stored snapshot (late-join), then relays buffered + live events — de-duped
   * against the snapshot by `updatedAt` — until the terminal `closed: true`
   * event, with a periodic heartbeat. Mirrors `HarnessProgressService.subscribeToProgress`.
   */
  subscribeToAssurance(consultationId: string): Observable<MessageEvent> {
    const channel = this.channel(consultationId);

    return new Observable<MessageEvent>((subscriber) => {
      let inner: Subscription | null = null;
      let bridgeSub: Subscription | null = null;

      (async () => {
        const messages$ = await this.redisSubscriber.subscribeToChannel(channel);
        const bridge = new ReplaySubject<string>();
        bridgeSub = messages$.subscribe(bridge);

        const snapshot = await this.cacheService.get(this.snapshotKey(consultationId));
        const snapshotUpdatedAt = this.parseUpdatedAt(snapshot);
        if (snapshot) {
          subscriber.next({ data: snapshot } as MessageEvent);
        }

        const relay$ = bridge.pipe(
          filter((raw: string) => !this.isDuplicateOfSnapshot(raw, snapshotUpdatedAt)),
          map((raw: string): MessageEvent => ({ data: raw }) as MessageEvent),
        );

        const heartbeat$ = interval(this.HEARTBEAT_MS).pipe(
          map((): MessageEvent => ({ data: JSON.stringify({ type: 'heartbeat', ts: new Date().toISOString() }) }) as MessageEvent),
        );

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
          message: 'Failed to initialise harness-assurance SSE subscription',
          consultationId,
          error: error instanceof Error ? error.message : String(error),
        });
        subscriber.next({ data: JSON.stringify({ error: 'Failed to subscribe to harness assurance', consultationId }) } as MessageEvent);
        subscriber.complete();
      });

      return () => {
        inner?.unsubscribe();
        bridgeSub?.unsubscribe();
      };
    });
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * Append/update one claim verdict:
   *   - different `jobId` than the prior snapshot → NEW run: prior discarded;
   *   - feed already closed (same run) → IGNORE (returns null);
   *   - existing claimId → updated in place (retried verdict);
   *   - new claimId → appended (capped at MAX_CLAIMS).
   */
  private foldClaim(
    consultationId: string,
    prior: HarnessAssuranceEventDto | null,
    dto: HarnessAssuranceEventRequest,
  ): HarnessAssuranceEventDto | null {
    const now = new Date().toISOString();
    // A different jobId is a different run — never merge two runs' verdicts.
    if (dto.jobId != null && prior?.jobId != null && dto.jobId !== prior.jobId) {
      prior = null;
    }
    if (prior?.closed) {
      return null; // the aggregate verdict already landed; ignore late claims
    }

    const claims: HarnessAssuranceClaimDto[] = (prior?.claims ?? []).map((c) => ({ ...c }));
    const existing = claims.find((c) => c.claimId === dto.claimId && c.sensor === dto.sensor);
    if (existing) {
      existing.verdict = dto.verdict;
      existing.at = now;
      if (dto.label) existing.label = dto.label;
      if (dto.ordinal != null) existing.ordinal = dto.ordinal;
    } else {
      if (claims.length >= this.MAX_CLAIMS) {
        return null; // snapshot at capacity — drop further claims
      }
      claims.push({
        claimId: dto.claimId,
        sensor: dto.sensor,
        verdict: dto.verdict,
        label: dto.label,
        ordinal: dto.ordinal,
        at: now,
      });
    }

    return {
      consultationId,
      tenantId: dto.tenantId ?? prior?.tenantId,
      jobId: dto.jobId ?? prior?.jobId,
      total: dto.total ?? prior?.total,
      claims,
      updatedAt: now,
      closed: false,
    };
  }

  private async persistAndPublish(consultationId: string, state: HarnessAssuranceEventDto): Promise<void> {
    const serialized = JSON.stringify(state);
    await this.cacheService.setex(this.snapshotKey(consultationId), this.SNAPSHOT_TTL, serialized);
    await this.cacheService.publish(this.channel(consultationId), serialized);
  }

  private parseUpdatedAt(snapshot: string | null | undefined): string | null {
    if (!snapshot) return null;
    try {
      const updatedAt = (JSON.parse(snapshot) as Partial<HarnessAssuranceEventDto>).updatedAt;
      return typeof updatedAt === 'string' ? updatedAt : null;
    } catch {
      return null;
    }
  }

  private isDuplicateOfSnapshot(raw: string, snapshotUpdatedAt: string | null): boolean {
    if (!snapshotUpdatedAt) return false;
    const updatedAt = this.parseUpdatedAt(raw);
    return updatedAt != null && updatedAt <= snapshotUpdatedAt;
  }

  private async loadSnapshot(consultationId: string): Promise<HarnessAssuranceEventDto | null> {
    const raw = await this.cacheService.get(this.snapshotKey(consultationId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<HarnessAssuranceEventDto>;
      if (parsed && Array.isArray(parsed.claims)) {
        return parsed as HarnessAssuranceEventDto;
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
