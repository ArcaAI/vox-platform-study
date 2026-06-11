import { StreamingAudioBridgeService, StreamingSessionService } from '@arcaai/applications';
import { Logger } from '@nestjs/common';
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

/** Buffered transcript ready for replay. */
interface BufferedTranscript {
  seq: number;
  msg: { type: string; seq?: number; [key: string]: unknown };
}

interface SessionInfo {
  sessionId: string;
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
}

@WebSocketGateway({ path: '/ws/stt-v2/stream' })
export class SttWsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(SttWsGateway.name);
  private readonly sessions = new Map<WebSocket, SessionInfo>();

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
  ) {}

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

    const session: SessionInfo = {
      sessionId,
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

    this.logger.log({
      message: 'WebSocket client connected',
      sessionId,
      userId: stored.userId,
      tenantId: stored.tenantId,
      activeSessions: this.sessions.size,
    });

    client.on('message', (data: Buffer | string) => {
      this.handleMessage(client, data).catch((err) => {
        this.logger.error({
          message: 'Unhandled error in message handler',
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    // TASK-298 D-1 — subscribe to results ONLY after the ticket gate passes.
    const resultSub = this.bridgeService.subscribeToResults(sessionId).subscribe({
      next: (msg) => {
        this.relayResult(client, session, msg as unknown as { type: string; isFinal?: boolean; [key: string]: unknown });
      },
      error: (err) => {
        this.logger.warn({
          message: 'Result stream error',
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.sendError(client, 'STREAM_ERROR', 'Result stream encountered an error');
      },
      complete: () => {
        if (client.readyState === client.OPEN) {
          client.send(
            JSON.stringify({
              type: 'status',
              status: 'closed',
              message: 'Transcription stream completed',
            }),
          );
        }
      },
    });

    session.resultSubscription = resultSub;
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
      this.enqueueFinalResult(client, session, tagged);
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
   * queue is bounded: on overflow the oldest entry is dropped with an error
   * log (the newest, most relevant finals survive; the resume buffer still
   * holds the dropped one for the reconnect-replay path).
   */
  private enqueueFinalResult(client: WebSocket, session: SessionInfo, tagged: { type: string; [key: string]: unknown }): void {
    session.pendingFinalResults.push(tagged);
    if (session.pendingFinalResults.length > WS_EGRESS_FINAL_QUEUE_LIMIT) {
      const dropped = session.pendingFinalResults.shift();
      session.droppedFinalResults++;
      this.logger.error({
        message: 'Final transcript dropped — bounded WS egress queue overflow (TASK-351 P1-4)',
        sessionId: session.sessionId,
        droppedFinalResults: session.droppedFinalResults,
        queueLimit: WS_EGRESS_FINAL_QUEUE_LIMIT,
        droppedSeq: (dropped as { seq?: number } | undefined)?.seq,
      });
    }
    if (!session.egressFlushTimer) {
      const timer = setInterval(() => this.flushPendingFinals(client, session), WS_EGRESS_FLUSH_POLL_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
      session.egressFlushTimer = timer;
    }
  }

  /**
   * TASK-351 P1-4 — drain poll: deliver queued finals in order while the
   * socket stays below the threshold; self-clears once the queue empties
   * (normal delivery resumes) or the socket is gone.
   */
  private flushPendingFinals(client: WebSocket, session: SessionInfo): void {
    if (client.readyState !== client.OPEN) {
      this.clearEgressState(session, 'socket closed');
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
    this.sessions.delete(client);

    if (session) {
      session.resultSubscription?.unsubscribe();
      this.bridgeService.unsubscribeFromResults(session.sessionId);
      this.clearEgressState(session, 'client disconnected');

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

      this.sessionService.removeSession(session.sessionId).catch((err) => {
        this.logger.warn({
          message: 'Session cleanup failed on disconnect',
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        // TASK-351 P1-3 (M6 part 2) — park the session for bounded retries
        // instead of leaking it until the STT-v2 inactivity reaper.
        this.removalRetry.enqueue(session.sessionId);
      });
    }
  }

  async handleMessage(client: WebSocket, rawData: string | Buffer): Promise<void> {
    const session = this.sessions.get(client);
    if (!session) {
      this.sendError(client, 'NO_SESSION', 'No active session for this connection');
      return;
    }

    if (Buffer.isBuffer(rawData)) {
      session.binarySeq++;
      this.forwardAudioFrame(client, session, session.binarySeq, rawData);
      return;
    }

    let msg: { type: string; [key: string]: unknown };
    try {
      const str = rawData as string;
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
          this.forwardAudioFrame(client, session, seq, data);
          break;
        }

        case 'stop': {
          await this.bridgeService.writeControlCommand(session.sessionId, 'finalize');
          break;
        }

        case 'resume': {
          // TASK-298 D-17 — resumability handshake.
          this.handleResume(client, session, msg);
          break;
        }

        case 'close': {
          session.resultSubscription?.unsubscribe();
          this.bridgeService.unsubscribeFromResults(session.sessionId);
          this.clearEgressState(session, 'session closed by client');
          await this.sessionService.removeSession(session.sessionId);
          this.sessions.delete(client);
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
  private forwardAudioFrame(client: WebSocket, session: SessionInfo, seq: number, data: Buffer): void {
    this.bridgeService.writeAudioFrame(session.sessionId, seq, data, session.sampleRate, 'pcm_s16le', false).catch((err) => {
      session.droppedAudioFrames++;
      this.logger.error({
        message: 'Error forwarding audio frame',
        sessionId: session.sessionId,
        seq,
        droppedAudioFrames: session.droppedAudioFrames,
        error: err instanceof Error ? err.message : String(err),
      });
      this.sendError(client, 'BRIDGE_ERROR', 'Failed to forward audio frame');
    });
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Handle the `{type:'resume', sessionId, lastSeq}` handshake from the SDK
   * (TASK-298 D-17). When the requested `lastSeq` is still inside the bounded
   * buffer, replay every buffered transcript with `seq > lastSeq` so the
   * client recovers without dropping any final transcript. When the gap
   * exceeds the buffer window, respond with `resume_failed` and the lowest
   * still-available seq so the client knows the loss size.
   */
  private handleResume(client: WebSocket, session: SessionInfo, msg: { type: string; [key: string]: unknown }): void {
    const reqSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
    const lastSeq = typeof msg.lastSeq === 'number' && Number.isFinite(msg.lastSeq) ? msg.lastSeq : null;

    if (!reqSessionId || reqSessionId !== session.sessionId || lastSeq === null) {
      if (client.readyState === client.OPEN) {
        client.send(
          JSON.stringify({
            type: 'resume_failed',
            sessionId: session.sessionId,
            reason: 'unknown_session',
          }),
        );
      }
      return;
    }

    const buffer = session.resumeBuffer;
    if (buffer.length === 0) {
      // Nothing buffered yet (e.g. first connect after server restart).
      // Acknowledge the resume without replay; the client will receive new
      // transcripts starting from `resultSeq + 1` as they come in.
      if (client.readyState === client.OPEN) {
        client.send(
          JSON.stringify({
            type: 'resumed',
            sessionId: session.sessionId,
            fromSeq: session.resultSeq,
          }),
        );
      }
      return;
    }

    const minAvailableSeq = buffer[0]!.seq;
    if (lastSeq < minAvailableSeq - 1) {
      if (client.readyState === client.OPEN) {
        client.send(
          JSON.stringify({
            type: 'resume_failed',
            sessionId: session.sessionId,
            reason: 'buffer_overflow',
            minAvailableSeq,
          }),
        );
      }
      return;
    }

    const toReplay = buffer.filter((b) => b.seq > lastSeq);
    if (client.readyState === client.OPEN) {
      client.send(
        JSON.stringify({
          type: 'resumed',
          sessionId: session.sessionId,
          fromSeq: toReplay.length > 0 ? toReplay[0]!.seq : session.resultSeq,
        }),
      );
      for (const entry of toReplay) {
        if (client.readyState === client.OPEN) {
          client.send(JSON.stringify(entry.msg));
        }
      }
    }
  }

  private sendError(client: WebSocket, code: string, message: string): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ type: 'error', code, message }));
    }
  }
}
