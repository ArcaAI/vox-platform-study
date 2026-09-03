import { Inject, Injectable, Logger, type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { closedFlagTerminal, sseFromRedisChannel } from '../../../common/sse/redis-channel-sse';
import { IRedisCacheService } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import type { HarnessLiveAssistRequest, HarnessRealtimeDeliveryAck, LiveAssistEventDto } from './dto';

/**
 * HarnessLiveAssistService — the live clinician-assist feed.
 *
 * Ephemeral, Redis-only (no Prisma), exactly like `HarnessProgressService`: the
 * interpreter posts one branch at a time through
 * `POST /internal/harness/consultations/:id/live-assist`; this folds it into a
 * two-branch snapshot (`consultation:live-assist:{id}:last`, 1h TTL for
 * SSE late-join) and publishes the full state on `consultation:live-assist:{id}`
 * for the relay.
 *
 * ─── WHY A NEW CHANNEL ──────────────────────────────────────────────────────
 *
 * This plane is DECLARED PHI-CARRYING: a correction proposal quotes the span it
 * would replace, verbatim from the clinician's note. That makes it a SIBLING OF
 * `live-summary` — same tenancy posture, same ticket-scoped SSE guard — and
 * emphatically NOT a use of the loop event plane, whose payload contract is
 * `extra="forbid"` and states it carries "ids/keys/labels only, NEVER note or
 * transcript text".
 *
 * It is also not folded INTO `live-summary`: that channel's payload is a
 * `LiveSummaryEventDto` the console renders as the running note, and a client
 * that only wants the note should not have to receive proposals to get it.
 *
 * ─── WHY A SNAPSHOT, AND WHY TWO BRANCHES ───────────────────────────────────
 *
 * A clinician who refreshes, or opens a second tab, must still see the standing
 * suggestions and proposals — an append-only feed would show them nothing until
 * the next interpreter flush. And the two branches are produced by DIFFERENT
 * nodes at different times, so a suggestions publish must leave the standing
 * corrections alone (and vice versa). Within a branch the newest publish REPLACES
 * the previous one: proposals are computed against a specific text state
 * (`textSha256`), so merging two generations of them would offer the clinician
 * offsets into text that no longer exists.
 *
 * Best-effort by contract, like every sibling publish path: a Redis hiccup acks
 * `{ ok: false }` and never throws, because a feed outage must not fail an
 * interpreter run.
 */
@Injectable()
export class HarnessLiveAssistService {
  private readonly logger = new Logger(HarnessLiveAssistService.name);

  private readonly CHANNEL_PREFIX = 'consultation:live-assist:';
  private readonly SNAPSHOT_TTL = 3600; // 1h — transient last-state for SSE late-join
  private readonly HEARTBEAT_MS = 15000; // keep idle streams alive through proxies

  constructor(
    @Inject(IRedisCacheService) private readonly cacheService: IRedisCacheService,
    private readonly redisSubscriber: RedisSubscriberService,
  ) {}

  /** Fold one branch into the standing state, store it, and publish the full state. */
  async publishAssist(consultationId: string, dto: HarnessLiveAssistRequest): Promise<HarnessRealtimeDeliveryAck> {
    try {
      const prior = await this.loadSnapshot(consultationId);
      const next = this.fold(consultationId, prior, dto);
      const serialized = JSON.stringify(next);

      await this.cacheService.setex(this.snapshotKey(consultationId), this.SNAPSHOT_TTL, serialized);
      await this.cacheService.publish(this.channel(consultationId), serialized);

      this.logger.debug({ message: 'Live assist published', consultationId, kind: dto.kind });
      return { ok: true };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to publish live assist (best-effort — the interpreter run is unaffected)',
        consultationId,
        kind: dto.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false };
    }
  }

  /**
   * SSE source for `GET /consultations/:id/live-assist/stream`. Same shape as
   * `HarnessProgressService.subscribeToProgress`: subscribe first (so nothing
   * published between the snapshot read and the subscription is lost), then emit
   * the snapshot for late-join, then relay live events.
   *
   * There is no terminal event: the assist feed has no "done" — the clinician's
   * navigation closes it. `closedFlagTerminal` is kept as the predicate so a
   * future terminal event needs no new plumbing; nothing sets `closed` today.
   */
  subscribeToAssist(consultationId: string): Observable<MessageEvent> {
    return sseFromRedisChannel(this.redisSubscriber, this.logger, {
      channel: this.channel(consultationId),
      heartbeatMs: this.HEARTBEAT_MS,
      loadSnapshot: () => this.cacheService.get(this.snapshotKey(consultationId)),
      isDuplicateOfSnapshot: (raw, snapshot) => this.isDuplicateOfSnapshot(raw, this.parseUpdatedAt(snapshot)),
      isTerminal: closedFlagTerminal,
      setupErrorPayload: JSON.stringify({ error: 'Failed to subscribe to live assist', consultationId }),
      logContext: { consultationId },
    });
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /** Replace the branch this publish carries; leave the other branch standing. */
  private fold(consultationId: string, prior: LiveAssistEventDto | null, dto: HarnessLiveAssistRequest): LiveAssistEventDto {
    const next: LiveAssistEventDto = {
      consultationId,
      tenantId: dto.tenantId ?? prior?.tenantId,
      suggestions: prior?.suggestions,
      corrections: prior?.corrections,
      suggestionsNodeType: prior?.suggestionsNodeType,
      correctionsNodeType: prior?.correctionsNodeType,
      provider: dto.provider ?? prior?.provider,
      model: dto.model ?? prior?.model,
      updatedAt: new Date().toISOString(),
    };

    if (dto.kind === 'suggestions') {
      next.suggestions = dto.suggestions ?? [];
      next.suggestionsNodeType = dto.nodeType ?? prior?.suggestionsNodeType;
    } else {
      next.corrections = dto.corrections;
      next.correctionsNodeType = dto.nodeType ?? prior?.correctionsNodeType;
    }

    return next;
  }

  /** Read + parse the stored snapshot; corrupt or missing → null (start fresh). */
  private async loadSnapshot(consultationId: string): Promise<LiveAssistEventDto | null> {
    const raw = await this.cacheService.get(this.snapshotKey(consultationId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<LiveAssistEventDto>;
      if (parsed && typeof parsed.consultationId === 'string') return parsed as LiveAssistEventDto;
    } catch {
      /* corrupt snapshot — treat as absent */
    }
    return null;
  }

  private parseUpdatedAt(snapshot: string | null | undefined): string | null {
    if (!snapshot) return null;
    try {
      const updatedAt = (JSON.parse(snapshot) as Partial<LiveAssistEventDto>).updatedAt;
      return typeof updatedAt === 'string' ? updatedAt : null;
    } catch {
      return null;
    }
  }

  /** True when a relayed event carries state the just-emitted snapshot already held. */
  private isDuplicateOfSnapshot(raw: string, snapshotUpdatedAt: string | null): boolean {
    if (!snapshotUpdatedAt) return false;
    const updatedAt = this.parseUpdatedAt(raw);
    return updatedAt != null && updatedAt <= snapshotUpdatedAt;
  }

  private channel(consultationId: string): string {
    return `${this.CHANNEL_PREFIX}${consultationId}`;
  }

  private snapshotKey(consultationId: string): string {
    return `${this.CHANNEL_PREFIX}${consultationId}:last`;
  }
}
