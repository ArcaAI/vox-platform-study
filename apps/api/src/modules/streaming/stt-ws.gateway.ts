import { StreamingAudioBridgeService, StreamingSessionService } from '@arcaai/applications';
import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import type { Subscription } from 'rxjs';
import type WebSocket from 'ws';
import type { Server } from 'ws';

interface SessionInfo {
  sessionId: string;
  connectedAt: Date;
  binarySeq: number;
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
  ) {}

  handleConnection(client: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
      client.close(4001, 'Missing required query parameter: sessionId');
      return;
    }

    const session: SessionInfo = {
      sessionId,
      connectedAt: new Date(),
      binarySeq: 0,
    };

    this.sessions.set(client, session);

    this.logger.log({
      message: 'WebSocket client connected',
      sessionId,
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

    const resultSub = this.bridgeService.subscribeToResults(sessionId).subscribe({
      next: (msg) => {
        if (client.readyState === client.OPEN) {
          client.send(JSON.stringify(msg));
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

  private sendError(client: WebSocket, code: string, message: string): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ type: 'error', code, message }));
    }
  }
}
