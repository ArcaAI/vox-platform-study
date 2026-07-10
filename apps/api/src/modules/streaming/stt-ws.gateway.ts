import { ISocketRegistryService, StreamingAudioBridgeService, StreamingSessionService } from '@arcaai/applications';
import { Inject, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import type { Subscription } from 'rxjs';
import type WebSocket from 'ws';
import type { Server } from 'ws';
import { StreamSessionTenantBindingService } from '../../common';
import { StreamTicketService } from '../auth/stream-ticket.service';
import { SessionRemovalRetryService } from './session-removal-retry.service';

/**
 * TASK-298 D-1 / D-17 + TASK-307 W5.8 (AC-22, audit D-8) — STT WebSocket
 * handshake-rejection close codes.
 *
 * Pre-W5.8 we used `4001 missing param` (sessionId / ticket) and
 * `4401 invalid ticket` (invalid / scope-mismatched). That gave a
 * probing client an enumeration signal: it could tell apart a valid
 * sessionId from an invalid one based on which 4xxx code came back.
 *
 * W5.8 collapses ALL handshake-failure paths to a single generic
 * `4401 Authentication failed` over the wire. The real reason for the
 * failure still flows into the server-side warn log so SRE dashboards
 * remain useful.
 *
 * 4401 — handshake failure (any cause)
 * 1011 — internal error (resume buffer corruption etc.)
 */
export const WS_CLOSE_CODES = {
  AUTH_FAILED: 4401,
} as const;

/**
 * The literal that goes onto the wire when we close a handshake.
 * Identical for every failure cause so it cannot be used to enumerate
 * sessions, tickets, or scope mismatches.
 */
export const WS_GENERIC_AUTH_REASON = 'Authentication failed';

/**
 * TASK-298 D-17 — bounded per-session transcript replay buffer.
 *
 * The gateway keeps the last `RESUME_BUFFER_SIZE` transcript messages for
 * every active session so that a brief disconnect (≤ buffer window) can be
 * resumed without dropping transcripts. Bound is per-session to cap total
 * memory at ~`activeSessions × RESUME_BUFFER_SIZE × avg msg size`.
 */
export const RESUME_BUFFER_SIZE = 200;

/**
 * TASK-351 P0-2 (C5) — fallback when no session meta was bound (legacy
 * clients / Redis blip at handshake). Matches the historical hardcoded rate.
 */
export const DEFAULT_SAMPLE_RATE = 16000;

/**
 * TASK-351 P1-4 (H6) — WS egress backpressure threshold. When the client
 * socket's `bufferedAmount` exceeds this many bytes, partial transcripts are
 * dropped and final transcripts are queued until the socket drains.
 * Default 512 KiB; overridable via `STT_WS_EGRESS_HIGH_WATERMARK_BYTES`.
 */
export const WS_EGRESS_HIGH_WATERMARK_BYTES = (() => {
  const raw = Number(process.env.STT_WS_EGRESS_HIGH_WATERMARK_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 512 * 1024;
})();

/**
 * TASK-351 P1-4 (H6) — bound on the per-session queue of finals awaiting a
 * socket drain. On overflow the OLDEST queued final is dropped with an error
 * log (never silently); the resume buffer (TASK-298 D-17) still holds it for
 * the reconnect-replay path.
 */
export const WS_EGRESS_FINAL_QUEUE_LIMIT = 200;

/**
 * TASK-351 P1-4 (H6) — drain-poll cadence for flushing queued finals. The
 * `ws` library exposes no drain event on its WebSocket wrapper, so we poll
 * `bufferedAmount` while (and only while) finals are queued.
 */
export const WS_EGRESS_FLUSH_POLL_MS = 50;

/**
 * TASK-457 C3-01 — resume grace window. On a TRANSIENT socket drop the gateway
 * keeps the session (its resume buffer, seq counter, and upstream STT-v2
 * session) alive for this long so the SAME session can reconnect and continue
 * without a duplicate flood or a silent freeze. Only when the window expires
 * with no reconnect is the upstream finalized. Overridable via
 * `STT_WS_RESUME_GRACE_MS`; default 15s.
 */
export const WS_RESUME_GRACE_MS = (() => {
  const raw = Number(process.env.STT_WS_RESUME_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
})();

/**
 * TASK-457 C3-01 — stable consumer-group name the gateway uses when subscribing
 * to `stt:result:{sessionId}`. Being stable per session (the stream is already
 * per-session) means the bridge resumes from the group's Redis-owned cursor on
 * a re-subscription rather than re-reading from `0-0`. Distinct from the
 * LiveDocumentationService reader's (default, unique) group, so both still
 * receive every result (fan-out preserved).
 */
export const WS_RESULT_CONSUMER_GROUP = 'captions';

/** Buffered transcript ready for replay. */
interface BufferedTranscript {
  seq: number;
  msg: { type: string; seq?: number; [key: string]: unknown };
}

interface SessionInfo {
  sessionId: string;
  /**
   * The CURRENT client socket. Mutable: on a reconnect within the grace window
   * the session is rebound to the new socket (TASK-457 C3-01), so every send
   * path reads `session.client` rather than a captured socket.
   */
  client: WebSocket;
  connectedAt: Date;
  binarySeq: number;
  /** Server-assigned monotonic transcript seq (TASK-298 D-17). */
  resultSeq: number;
  /** Last N transcripts retained for replay (TASK-298 D-17). */
  resumeBuffer: BufferedTranscript[];
  /** User id from the consumed stream ticket (TASK-298 D-1). */
  userId: string;
  /** Tenant id from the consumed stream ticket (TASK-298 D-1). */
  tenantId: string | null;
  /**
   * Session-negotiated audio sample rate, read from the session meta bound
   * by `createStreamSession` (TASK-351 P0-2 / C5). Defaults to 16000.
   */
  sampleRate: number;
  /** Frames whose async Redis write failed (TASK-351 P0-2 / C1). */
  droppedAudioFrames: number;
  /** Partials dropped because the WS egress buffer was over the threshold (TASK-351 P1-4 / H6). */
  droppedPartialResults: number;
  /** Finals dropped because the bounded egress queue overflowed (TASK-351 P1-4 / H6). */
  droppedFinalResults: number;
  /** Finals awaiting delivery while the socket drains (TASK-351 P1-4 / H6). */
  pendingFinalResults: Array<{ type: string; [key: string]: unknown }>;
  /** Poll timer that flushes `pendingFinalResults` once the socket drains. */
  egressFlushTimer?: ReturnType<typeof setInterval>;
  resultSubscription?: Subscription;
  /**
   * TASK-457 C3-01 — grace-window timer armed on a transient disconnect. If the
   * same session reconnects before it fires the timer is cleared and the
   * session continues; otherwise the upstream is finalized. Undefined while the
   * socket is connected.
   */
  graceTimer?: ReturnType<typeof setTimeout>;
  /**
   * True once the session is being torn down for real (explicit `close`, or a
   * grace window that expired). Guards against a late disconnect re-arming the
   * grace window after finalize.
   */
  finalizing?: boolean;
}

@WebSocketGateway({ path: '/ws/stt-v2/stream' })
export class SttWsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(SttWsGateway.name);
  private readonly sessions = new Map<WebSocket, SessionInfo>();
  /**
   * TASK-457 C3-01 — resume state keyed by `sessionId` (not per-socket), so a
   * reconnect within the grace window finds the SAME `SessionInfo` (its resume
   * buffer + seq + live result subscription) and rebinds to the new socket
   * instead of building a fresh, empty one that re-reads from `0-0`.
   */
  private readonly sessionsById = new Map<string, SessionInfo>();
  /**
   * TASK-386 (#5/#17) — republishes this instance's live-socket count so the
   * per-instance Redis key never expires between connect/disconnect bursts (key
   * TTL is 45s in `SocketRegistryService`). Cleared on module destroy.
   */
  private socketHeartbeat?: ReturnType<typeof setInterval>;

  constructor(
    private readonly sessionService: StreamingSessionService,
    private readonly bridgeService: StreamingAudioBridgeService,
    private readonly streamTicketService: StreamTicketService,
    // TASK-351 P0-2 (C5): reads the session meta (negotiated sampleRate)
    // bound by `createStreamSession`.
    private readonly sessionBinding: StreamSessionTenantBindingService,
    // TASK-351 P1-3 (M6 part 2): retries failed upstream session removals
    // with backoff so STT-v2 sessions are not leaked on disconnect.
    private readonly removalRetry: SessionRemovalRetryService,
    // TASK-386 (#5/#17): publishes this instance's open-socket count to Redis
    // for the platform-metrics aggregate. Optional so the gateway still boots
    // in stacks that don't wire the platform-metrics module (best-effort).
    @Optional()
    @Inject(ISocketRegistryService)
    private readonly socketRegistry?: ISocketRegistryService,
  ) {}

  onModuleInit(): void {
    // Publish an initial 0 immediately, then refresh on a cadence well under the
    // 45s key TTL so a live instance never expires between socket events.
    this.publishSocketCount();
    this.socketHeartbeat = setInterval(() => this.publishSocketCount(), 20_000);
    // Don't keep the event loop alive for the heartbeat alone.
    this.socketHeartbeat.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.socketHeartbeat) {
      clearInterval(this.socketHeartbeat);
      this.socketHeartbeat = undefined;
    }
    // TASK-457 I3 — on SIGTERM / rolling deploy, best-effort FINALIZE every
    // live + in-grace session so the upstream STT-v2 sessions (and their
    // capacity slots) are not orphaned until the STT-v2 reaper. Clear timers,
    // unsubscribe, and DELETE the upstream session; bounded-await the removals
    // so a deploy tidies up without hanging shutdown.
    const removals: Array<Promise<unknown>> = [];
    for (const session of [...this.sessionsById.values()]) {
      if (session.graceTimer) {
        clearTimeout(session.graceTimer);
        session.graceTimer = undefined;
      }
      if (session.egressFlushTimer) {
        clearInterval(session.egressFlushTimer);
        session.egressFlushTimer = undefined;
      }
      if (session.finalizing) continue;
      session.finalizing = true;
      session.resultSubscription?.unsubscribe();
      this.bridgeService.unsubscribeFromResults(session.sessionId);
      removals.push(this.sessionService.removeSession(session.sessionId).catch(() => {}));
    }
    this.sessions.clear();
    this.sessionsById.clear();
    if (removals.length > 0) {
      // Bounded so shutdown never hangs on a slow/unreachable STT-v2.
      await Promise.race([Promise.allSettled(removals), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  }

  /**
   * TASK-386 (#5/#17) — best-effort publish of THIS instance's live-socket count
   * to the Redis registry. Never throws: a Redis blip must not affect the WS
   * data path.
   *
   * TASK-392 (concurrency) — also publishes the per-tenant breakdown so the
   * entitlements concurrency gate can compare a tenant's live active sessions
   * against `maxConcurrentSessions` across a horizontally-scaled deployment.
   */
  private publishSocketCount(): void {
    void this.socketRegistry?.publishLocalCount(this.getActiveSessionCount()).catch((err) => {
      this.logger.debug({
        message: 'Failed to publish open-socket count',
        error: err instanceof Error ? err.message : String(err),
      });
    });
    void this.socketRegistry?.publishLocalTenantCounts(this.getPerTenantSessionCounts()).catch((err) => {
      this.logger.debug({
        message: 'Failed to publish per-tenant open-socket counts',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * TASK-392 (concurrency) — THIS instance's live open-socket count grouped by
   * tenant. Null-tenant sessions (legacy/system) are excluded: they are ungated
   * and must not consume any tenant's concurrency budget.
   */
  private getPerTenantSessionCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const session of this.sessions.values()) {
      const tenantId = session.tenantId;
      if (!tenantId) continue;
      counts[tenantId] = (counts[tenantId] ?? 0) + 1;
    }
    return counts;
  }

  async handleConnection(client: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url || '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    const ticket = url.searchParams.get('ticket');

    // TASK-298 D-1 + TASK-307 W5.8 — auth gate runs BEFORE we register
    // the session or subscribe to the result stream, and every
    // rejection path closes with the SAME generic (code, reason) so
    // the client cannot enumerate sessions / tickets / scopes by
    // probing. The real cause goes to the warn log.
    if (!sessionId) {
      this.logger.warn({
        message: 'WS handshake rejected — missing sessionId',
      });
      client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      return;
    }

    if (!ticket) {
      this.logger.warn({
        message: 'WS handshake rejected — missing ticket',
        sessionId,
      });
      client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      return;
    }

    const stored = await this.streamTicketService.consumeTicket(ticket);
    if (!stored) {
      this.logger.warn({
        message: 'WS handshake rejected — invalid stream ticket',
        sessionId,
      });
      client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      return;
    }

    const expectedScope = `stt_session:${sessionId}`;
    if (stored.scope !== expectedScope) {
      this.logger.warn({
        message: 'WS handshake rejected — ticket scope mismatch',
        sessionId,
        expectedScope,
        actualScope: stored.scope,
      });
      client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      return;
    }

    // TASK-450 C4-01 — the scope string above only proves the ticket was
    // minted FOR this sessionId, not that the minting tenant OWNS the
    // session. Verify the ticket's tenant against the session's owning
    // tenant (the gateway-side binding written at session create), mirroring
    // the DELETE route's `assertStreamSessionOwnership`. Missing binding,
    // mismatch, and lookup failure all reject fail-closed with the same
    // generic close — no enumeration signal, and no tenant ids in the log.
    let boundTenant: string | null = null;
    try {
      boundTenant = await this.sessionBinding.lookup(sessionId);
    } catch (err) {
      this.logger.warn({
        message: 'WS handshake — session tenant binding lookup failed (fail-closed)',
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (boundTenant === null || boundTenant !== stored.tenantId) {
      this.logger.warn({
        message: 'WS handshake rejected — session tenant binding missing or mismatched',
        sessionId,
      });
      client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      return;
    }

    // TASK-351 P0-2 (C5) — read the negotiated sampleRate bound at session
    // creation. Best-effort: a missing/corrupt record or a Redis blip falls
    // back to the historical 16000 and never rejects the handshake.
    let sampleRate: number = DEFAULT_SAMPLE_RATE;
    try {
      const meta = await this.sessionBinding.lookupSessionMeta(sessionId);
      if (meta) {
        sampleRate = meta.sampleRate;
      }
    } catch (err) {
      this.logger.warn({
        message: 'Session meta lookup failed — defaulting sampleRate',
        sessionId,
        sampleRate,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // TASK-457 C3-01 — RECONNECT within the grace window: a prior transient
    // drop kept this session (its resume buffer, seq, and live result
    // subscription) alive. Rebind it to the NEW socket instead of building a
    // fresh, empty one that re-reads from 0-0. The client then sends the D-17
    // resume handshake to replay anything it missed.
    const existing = this.sessionsById.get(sessionId);
    if (existing) {
      this.rebindSession(existing, client, stored);
      return;
    }

    const session: SessionInfo = {
      sessionId,
      client,
      connectedAt: new Date(),
      binarySeq: 0,
      resultSeq: 0,
      resumeBuffer: [],
      userId: stored.userId,
      tenantId: stored.tenantId,
      sampleRate,
      droppedAudioFrames: 0,
      droppedPartialResults: 0,
      droppedFinalResults: 0,
      pendingFinalResults: [],
    };

    this.sessions.set(client, session);
    this.sessionsById.set(sessionId, session);
    // TASK-386 (#5/#17) — refresh the multi-instance open-socket aggregate.
    this.publishSocketCount();

    this.logger.log({
      message: 'WebSocket client connected',
      sessionId,
      userId: stored.userId,
      tenantId: stored.tenantId,
      activeSessions: this.sessions.size,
    });

    this.attachMessageHandler(client, sessionId);

    // TASK-298 D-1 — subscribe to results ONLY after the ticket gate passes.
    this.subscribeSessionResults(session);

    // TASK-457 I1 — the async auth/lookup awaits above mean a client that
    // sends resume/audio the instant its socket opens would race registration
    // (NO_SESSION → dropped resume → silent freeze). Emit an explicit readiness
    // ack AFTER registration + subscription so the client gates its first
    // resume/audio on it (a deterministic gate, not a timing guess).
    this.sendReady(session);
  }

  /**
   * TASK-457 C3-01 — (re)establish the result subscription for a session.
   * Uses the STABLE `captions` consumer group so the bridge resumes from the
   * group's persisted cursor (never a 0-0 re-read); every send path reads
   * `session.client`, so a rebind redirects output to the reconnected socket.
   * Any prior subscription is torn down first (exactly one live reader).
   */
  private subscribeSessionResults(session: SessionInfo): void {
    session.resultSubscription?.unsubscribe();
    session.resultSubscription = this.bridgeService.subscribeToResults(session.sessionId, { consumerGroup: WS_RESULT_CONSUMER_GROUP }).subscribe({
      next: (msg) => {
        this.relayResult(session.client, session, msg as unknown as { type: string; isFinal?: boolean; [key: string]: unknown });
      },
      error: (err) => {
        this.logger.warn({
          message: 'Result stream error',
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.sendError(session.client, 'STREAM_ERROR', 'Result stream encountered an error');
      },
      complete: () => {
        if (session.client.readyState === session.client.OPEN) {
          session.client.send(
            JSON.stringify({
              type: 'status',
              status: 'closed',
              message: 'Transcription stream completed',
            }),
          );
        }
      },
    });
  }

  /** TASK-457 I1 — explicit readiness ack the client gates its first send on. */
  private sendReady(session: SessionInfo): void {
    this.sendJson(session.client, { type: 'ready', sessionId: session.sessionId, fromSeq: session.resultSeq + 1 });
  }

  /**
   * TASK-457 C3-01 — register the per-socket message handler. Honors the ws
   * `isBinary` frame flag: binary frames are audio, text frames (delivered by
   * ws@8 as a Buffer with `isBinary === false`) are JSON control. Without this
   * the `{type:'resume'|'stop'|'close'}` control channel was misclassified as
   * audio and the resume handshake was unanswerable.
   */
  private attachMessageHandler(client: WebSocket, sessionId: string): void {
    client.on('message', (data: Buffer, isBinary: boolean) => {
      this.handleMessage(client, data, isBinary).catch((err) => {
        this.logger.error({
          message: 'Unhandled error in message handler',
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  /**
   * TASK-457 C3-01 — rebind a grace-window session to a reconnecting socket.
   * The upstream STT-v2 session and the result subscription stayed alive, so
   * the resume buffer + seq are intact; we swap the socket, cancel the grace
   * timer, and RE-ESTABLISH the result subscription (the transient disconnect
   * tore down the old reader so a cross-instance reconnect wouldn't split the
   * shared caption group — TASK-457 C1). The re-established reader resumes from
   * the group's persisted cursor; the client drives replay via the D-17
   * resume handshake.
   */
  private rebindSession(session: SessionInfo, client: WebSocket, stored: { userId: string; tenantId: string | null }): void {
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = undefined;
    }
    session.finalizing = false;

    // Drop the stale socket mapping (defensive — normally already removed on
    // disconnect) and bind the new one.
    const previous = session.client;
    if (previous && previous !== client) {
      this.sessions.delete(previous);
    }
    session.client = client;
    session.userId = stored.userId;
    session.tenantId = stored.tenantId;
    session.connectedAt = new Date();
    this.sessions.set(client, session);
    this.publishSocketCount();

    this.attachMessageHandler(client, session.sessionId);
    // Re-establish the captions reader (stable group → resumes from the
    // persisted cursor, no 0-0 flood). Redirects to the new socket.
    this.subscribeSessionResults(session);

    this.logger.log({
      message: 'WebSocket client reconnected within grace window (TASK-457 C3-01)',
      sessionId: session.sessionId,
      resultSeq: session.resultSeq,
      bufferedForReplay: session.resumeBuffer.length,
      activeSessions: this.sessions.size,
    });

    // TASK-457 I1 — readiness ack so the client gates its resume on it.
    this.sendReady(session);
  }

  /**
   * TASK-351 P1-4 (H6) — relay a bridge result to the WS client with egress
   * backpressure. When `client.bufferedAmount` exceeds the high-watermark
   * (or finals are already queued — preserves delivery order across the
   * drain window):
   *   - PARTIAL transcripts are DROPPED (counted, debug-logged). They are
   *     dropped BEFORE seq-tagging so a stale partial never consumes a seq
   *     or occupies the resume buffer.
   *   - FINAL transcripts are queued (bounded) and flushed in order once
   *     the socket drains below the threshold — finals are never dropped
   *     silently.
   * Non-transcript messages (status etc.) are tiny and rare — they bypass
   * the backpressure policy.
   */
  private relayResult(client: WebSocket, session: SessionInfo, msg: { type: string; isFinal?: boolean; [key: string]: unknown }): void {
    const isTranscript = msg?.type === 'transcript';
    const backpressured = this.isEgressOverThreshold(client) || session.pendingFinalResults.length > 0;

    if (isTranscript && backpressured && msg.isFinal !== true) {
      session.droppedPartialResults++;
      this.logger.debug({
        message: 'Dropped partial transcript — WS egress backpressure (TASK-351 P1-4)',
        sessionId: session.sessionId,
        droppedPartialResults: session.droppedPartialResults,
        bufferedAmount: this.getBufferedAmount(client),
      });
      return;
    }

    const tagged = this.tagAndBuffer(session, msg);

    if (isTranscript && backpressured && msg.isFinal === true) {
      this.enqueueFinalResult(session, tagged);
      return;
    }

    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(tagged));
    }
  }

  /** TASK-351 P1-4 — `bufferedAmount` of the client socket (0 when absent). */
  private getBufferedAmount(client: WebSocket): number {
    return (client as { bufferedAmount?: number }).bufferedAmount ?? 0;
  }

  private isEgressOverThreshold(client: WebSocket): boolean {
    return this.getBufferedAmount(client) > WS_EGRESS_HIGH_WATERMARK_BYTES;
  }

  /**
   * TASK-351 P1-4 — queue a final for delivery after the socket drains. The
   * queue is bounded: on overflow the oldest entry is dropped with an error log.
   *
   * TASK-457 C3-03 — the previous claim that "the resume buffer still holds the
   * dropped one" was FALSE: `tagAndBuffer` (bound `RESUME_BUFFER_SIZE`) runs
   * microseconds before this enqueue and the resume buffer evicts the same final
   * in lockstep, so an overflowed final is in NEITHER the live queue NOR the
   * resume buffer. It survives only in the durable STT-v2 transcript (the
   * clinical system of record). We therefore emit an EXPLICIT gap marker so the
   * loss is never silent — the client sees the seq discontinuity and reconciles
   * against the persisted transcript rather than freezing.
   */
  private enqueueFinalResult(session: SessionInfo, tagged: { type: string; [key: string]: unknown }): void {
    session.pendingFinalResults.push(tagged);
    if (session.pendingFinalResults.length > WS_EGRESS_FINAL_QUEUE_LIMIT) {
      const dropped = session.pendingFinalResults.shift();
      session.droppedFinalResults++;
      const droppedSeq = (dropped as { seq?: number } | undefined)?.seq;
      this.logger.error({
        message: 'Final transcript dropped — bounded WS egress queue overflow (TASK-457 C3-03 / TASK-351 P1-4)',
        sessionId: session.sessionId,
        droppedFinalResults: session.droppedFinalResults,
        queueLimit: WS_EGRESS_FINAL_QUEUE_LIMIT,
        droppedSeq,
      });
      this.emitGapMarker(session, droppedSeq);
    }
    if (!session.egressFlushTimer) {
      const timer = setInterval(() => this.flushPendingFinals(session), WS_EGRESS_FLUSH_POLL_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
      session.egressFlushTimer = timer;
    }
  }

  /**
   * TASK-457 C3-03 — explicit gap marker so a dropped final is never a SILENT
   * loss. Tiny control frame; sent even while the transcript stream is
   * backpressured (its congestion is what forced the drop). Recoverable from
   * the durable transcript on the client side.
   */
  private emitGapMarker(session: SessionInfo, droppedSeq?: number): void {
    const client = session.client;
    if (client.readyState === client.OPEN) {
      client.send(
        JSON.stringify({
          type: 'gap',
          reason: 'egress_overflow',
          sessionId: session.sessionId,
          ...(droppedSeq != null ? { droppedSeq } : {}),
        }),
      );
    }
  }

  /**
   * TASK-351 P1-4 — drain poll: deliver queued finals in order while the
   * socket stays below the threshold; self-clears once the queue empties
   * (normal delivery resumes) or the socket is gone. Targets `session.client`
   * so a grace-window rebind flushes to the reconnected socket (TASK-457).
   */
  private flushPendingFinals(session: SessionInfo): void {
    const client = session.client;
    if (client.readyState !== client.OPEN) {
      // Socket gone mid-drain. If the session is being finalized, drop the
      // queue; otherwise (a transient drop pending its grace window) keep the
      // queued finals so a reconnect can still receive them.
      if (session.finalizing) {
        this.clearEgressState(session, 'socket closed');
      }
      return;
    }
    while (session.pendingFinalResults.length > 0 && !this.isEgressOverThreshold(client)) {
      const next = session.pendingFinalResults.shift()!;
      client.send(JSON.stringify(next));
    }
    if (session.pendingFinalResults.length === 0 && session.egressFlushTimer) {
      clearInterval(session.egressFlushTimer);
      session.egressFlushTimer = undefined;
    }
  }

  /** TASK-351 P1-4 — teardown of the egress queue + poll timer. */
  private clearEgressState(session: SessionInfo, reason: string): void {
    if (session.egressFlushTimer) {
      clearInterval(session.egressFlushTimer);
      session.egressFlushTimer = undefined;
    }
    if (session.pendingFinalResults.length > 0) {
      this.logger.warn({
        message: 'Discarding queued finals — WS egress teardown (TASK-351 P1-4)',
        sessionId: session.sessionId,
        reason,
        discarded: session.pendingFinalResults.length,
      });
      session.pendingFinalResults = [];
    }
  }

  /**
   * Tag transcript messages with a server-assigned monotonic `seq` and push
   * onto the bounded resume buffer (TASK-298 D-17). Non-transcript messages
   * pass through unchanged.
   */
  private tagAndBuffer(session: SessionInfo, msg: { type: string; [key: string]: unknown }): { type: string; [key: string]: unknown } {
    if (msg?.type !== 'transcript') {
      return msg;
    }
    session.resultSeq += 1;
    const tagged = { ...msg, seq: session.resultSeq };
    session.resumeBuffer.push({ seq: session.resultSeq, msg: tagged });
    if (session.resumeBuffer.length > RESUME_BUFFER_SIZE) {
      session.resumeBuffer.splice(0, session.resumeBuffer.length - RESUME_BUFFER_SIZE);
    }
    return tagged;
  }

  handleDisconnect(client: WebSocket): void {
    const session = this.sessions.get(client);
    // A grace-window rebind may already have moved this session to a NEW socket;
    // a late close of the OLD socket must not tear the live session down.
    if (!session || session.client !== client) {
      this.sessions.delete(client);
      return;
    }

    this.sessions.delete(client);
    // TASK-386 (#5/#17) — refresh the multi-instance open-socket aggregate.
    this.publishSocketCount();

    this.logger.log({
      message: 'WebSocket client disconnected',
      sessionId: session.sessionId,
      droppedAudioFrames: session.droppedAudioFrames,
      // TASK-351 P1-4 (H6) — egress backpressure accounting, mirroring
      // the droppedAudioFrames pattern above.
      droppedPartialResults: session.droppedPartialResults,
      droppedFinalResults: session.droppedFinalResults,
      activeSessions: this.sessions.size,
    });

    // Already being torn down for real (explicit close / prior grace expiry).
    if (session.finalizing) {
      return;
    }

    // TASK-457 C1 — STOP this session's captions reader immediately so a dead
    // client's reader does NOT keep consuming/ACKing the shared `captions`
    // group for the whole grace window. Cross-instance that would split the
    // live captions (Redis load-balances new results between the dead reader
    // and the reconnected client's reader on the same group); on ANY instance
    // it wastes the group's cursor. Only THIS gateway subscription is dropped
    // (via the bridge Observable's finalize, which disconnects the reader) —
    // NOT `unsubscribeFromResults`, which is the session-wide teardown that
    // would also abort LiveDocumentationService. The upstream STT-v2 session
    // stays alive; a reconnect re-establishes the reader from the persisted
    // group cursor.
    session.resultSubscription?.unsubscribe();
    session.resultSubscription = undefined;

    // TASK-457 C3-01 — a TRANSIENT disconnect must NOT finalize the upstream.
    // Keep the session (resume buffer + seq + upstream STT-v2 session) alive for
    // the grace window so the SAME session can reconnect anywhere and continue.
    // Only when the window expires with no reconnect do we finalize.
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
    }
    const timer = setTimeout(() => this.finalizeSession(session, 'grace window expired'), WS_RESUME_GRACE_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    session.graceTimer = timer;
  }

  /**
   * TASK-457 C3-01 — finalize a session for real: unsubscribe from results,
   * tell STT-v2 to finalize (with the M6 removal-retry fallback), drop all
   * state. Idempotent. Called on an explicit `close` or when the resume grace
   * window expires with no reconnect.
   */
  private finalizeSession(session: SessionInfo, reason: string): void {
    if (session.finalizing && reason === 'grace window expired') {
      // A concurrent close already finalized it.
      return;
    }
    session.finalizing = true;
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = undefined;
    }
    session.resultSubscription?.unsubscribe();
    this.bridgeService.unsubscribeFromResults(session.sessionId);
    this.clearEgressState(session, reason);
    this.sessions.delete(session.client);
    this.sessionsById.delete(session.sessionId);
    this.publishSocketCount();

    this.logger.log({
      message: 'Streaming session finalized',
      sessionId: session.sessionId,
      reason,
    });

    this.sessionService.removeSession(session.sessionId).catch((err) => {
      this.logger.warn({
        message: 'Session cleanup failed on finalize',
        sessionId: session.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // TASK-351 P1-3 (M6 part 2) — park the session for bounded retries
      // instead of leaking it until the STT-v2 inactivity reaper.
      this.removalRetry.enqueue(session.sessionId);
    });
  }

  async handleMessage(client: WebSocket, rawData: string | Buffer, isBinary?: boolean): Promise<void> {
    const session = this.sessions.get(client);
    if (!session) {
      this.sendError(client, 'NO_SESSION', 'No active session for this connection');
      return;
    }

    // TASK-457 — route on the ws `isBinary` frame flag, NOT `Buffer.isBuffer`:
    // ws@8 delivers TEXT frames as a Buffer too, so a Buffer with
    // `isBinary === false` is a JSON control frame ({resume|stop|close}), not
    // audio. Misrouting it as audio was why the resume handshake was dead.
    // (`isBinary` is undefined only on direct unit-test calls; a bare string is
    // then treated as JSON, a Buffer must set the flag explicitly.)
    if (isBinary === true) {
      session.binarySeq++;
      const audio = Buffer.isBuffer(rawData) ? rawData : Buffer.from(String(rawData));
      this.forwardAudioFrame(session, session.binarySeq, audio);
      return;
    }

    let msg: { type: string; [key: string]: unknown };
    try {
      const str = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
      msg = JSON.parse(str);
    } catch {
      this.sendError(client, 'INVALID_JSON', 'Message must be valid JSON');
      return;
    }

    const { type } = msg;

    try {
      switch (type) {
        case 'audio': {
          const seq = typeof msg.seq === 'number' ? msg.seq : ++session.binarySeq;
          const data = Buffer.from(String(msg.data), 'base64');
          this.forwardAudioFrame(session, seq, data);
          break;
        }

        case 'stop': {
          await this.bridgeService.writeControlCommand(session.sessionId, 'finalize');
          break;
        }

        case 'resume': {
          // TASK-298 D-17 / TASK-457 C3-01 — resumability handshake.
          this.handleResume(session, msg);
          break;
        }

        case 'close': {
          // TASK-457 C3-01 — an explicit close is a REAL end (no grace window):
          // finalize the upstream immediately.
          this.finalizeSession(session, 'session closed by client');
          client.close(1000, 'Session closed by client');
          break;
        }

        default:
          this.sendError(client, 'UNKNOWN_TYPE', `Unknown message type: ${type}`);
      }
    } catch (err) {
      this.logger.error({
        message: 'Error handling WebSocket message',
        sessionId: session.sessionId,
        type,
        error: err instanceof Error ? err.message : String(err),
      });
      this.sendError(client, 'INTERNAL_ERROR', 'Failed to process message');
    }
  }

  /**
   * TASK-351 P0-2 (C1) — forward an audio frame WITHOUT awaiting the Redis
   * ack. ioredis preserves per-connection command order, so XADD ordering
   * (and the audio-before-finalize ordering relied on by `stop`) is
   * unaffected; awaiting each ack only added per-frame promise/microtask
   * overhead at 10–125 frames/s/session. Failures are counted on the
   * session and surfaced to the client as BRIDGE_ERROR — the SDK's
   * `lastSeq` resume protocol handles recovery.
   */
  private forwardAudioFrame(session: SessionInfo, seq: number, data: Buffer): void {
    this.bridgeService.writeAudioFrame(session.sessionId, seq, data, session.sampleRate, 'pcm_s16le', false).catch((err) => {
      session.droppedAudioFrames++;
      this.logger.error({
        message: 'Error forwarding audio frame',
        sessionId: session.sessionId,
        seq,
        droppedAudioFrames: session.droppedAudioFrames,
        error: err instanceof Error ? err.message : String(err),
      });
      this.sendError(session.client, 'BRIDGE_ERROR', 'Failed to forward audio frame');
    });
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Handle the `{type:'resume', sessionId, lastSeq}` handshake from the SDK
   * (TASK-298 D-17 / TASK-457 C3-01). A successful resume ALWAYS acknowledges
   * continuation from the next unseen seq (`fromSeq = lastSeq + 1`) and replays
   * every buffered transcript with `seq > lastSeq` — never re-sending anything
   * with `seq <= lastSeq` (no duplicate flood). When the requested `lastSeq` is
   * behind the oldest still-buffered seq the gap exceeds the window: respond
   * with `resume_failed` + the lowest still-available seq (the loss is in the
   * durable transcript).
   */
  private handleResume(session: SessionInfo, msg: { type: string; [key: string]: unknown }): void {
    const client = session.client;
    const reqSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
    const lastSeq = typeof msg.lastSeq === 'number' && Number.isFinite(msg.lastSeq) ? msg.lastSeq : null;

    if (!reqSessionId || reqSessionId !== session.sessionId || lastSeq === null) {
      this.sendJson(client, { type: 'resume_failed', sessionId: session.sessionId, reason: 'unknown_session' });
      return;
    }

    const buffer = session.resumeBuffer;
    if (buffer.length > 0) {
      const minAvailableSeq = buffer[0]!.seq;
      if (lastSeq < minAvailableSeq - 1) {
        this.sendJson(client, { type: 'resume_failed', sessionId: session.sessionId, reason: 'buffer_overflow', minAvailableSeq });
        return;
      }
    }

    // Success — continuation from the NEXT unseen seq, then replay the unseen
    // buffered transcripts in order. An empty buffer (or a caught-up client)
    // still gets `resumed fromSeq: lastSeq + 1` and continues with live results.
    const toReplay = buffer.filter((b) => b.seq > lastSeq);
    this.sendJson(client, { type: 'resumed', sessionId: session.sessionId, fromSeq: lastSeq + 1 });
    for (const entry of toReplay) {
      this.sendJson(client, entry.msg);
    }
  }

  private sendJson(client: WebSocket, payload: unknown): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }

  private sendError(client: WebSocket, code: string, message: string): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ type: 'error', code, message }));
    }
  }
}
