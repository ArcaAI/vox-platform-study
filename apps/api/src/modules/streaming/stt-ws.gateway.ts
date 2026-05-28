import { StreamingAudioBridgeService, StreamingSessionService } from '@arcaai/applications';
import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import type { Subscription } from 'rxjs';
import type WebSocket from 'ws';
import type { Server } from 'ws';
import { StreamTicketService } from '../auth/stream-ticket.service';

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

    const session: SessionInfo = {
      sessionId,
      connectedAt: new Date(),
      binarySeq: 0,
      resultSeq: 0,
      resumeBuffer: [],
      userId: stored.userId,
      tenantId: stored.tenantId,
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
        const tagged = this.tagAndBuffer(session, msg as unknown as { type: string; [key: string]: unknown });
        if (client.readyState === client.OPEN) {
          client.send(JSON.stringify(tagged));
        }
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

      this.logger.log({
        message: 'WebSocket client disconnected',
        sessionId: session.sessionId,
        activeSessions: this.sessions.size,
      });

      this.sessionService.removeSession(session.sessionId).catch((err) => {
        this.logger.warn({
          message: 'Session cleanup failed on disconnect',
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
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
      try {
        session.binarySeq++;
        await this.bridgeService.writeAudioFrame(session.sessionId, session.binarySeq, rawData, 16000, 'pcm_s16le', false);
      } catch (err) {
        this.logger.error({
          message: 'Error forwarding binary audio frame',
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.sendError(client, 'BRIDGE_ERROR', 'Failed to forward audio frame');
      }
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
          await this.bridgeService.writeAudioFrame(session.sessionId, seq, data, 16000, 'pcm_s16le', false);
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
