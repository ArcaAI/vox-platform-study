import { IApiKeyService, StreamingAudioBridgeService, StreamingSessionService } from '@arcaai/applications';
import { Inject, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import type { Subscription } from 'rxjs';
import WebSocket from 'ws';
import { StreamSessionTenantBindingService } from '../../common';
import { SttCompatSessionMetadataService } from './stt-compat-session-metadata.service';

const AUDIO_FRAME_TYPE = 1;
const MAX_METADATA_BYTES = 8 * 1024;
const DEFAULT_SAMPLE_RATE = 16000;
const AUTH_CLOSE_CODE = 4401;
const AUTH_CLOSE_REASON = 'Authentication failed';

type LegacyMessage = { type?: string; sessionId?: string; metadata?: unknown; [key: string]: unknown };
type LegacyMetadata = Record<string, unknown>;

type LegacySession = {
  client: WebSocket;
  sessionId: string;
  sampleRate: number;
  sequence: number;
  language?: string;
  metadata: LegacyMetadata;
  results: Subscription;
};

@WebSocketGateway({ path: '/stt' })
export class SttCompatGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(SttCompatGateway.name);
  private readonly sessions = new Map<WebSocket, LegacySession>();
  private readonly sessionsById = new Map<string, LegacySession>();

  constructor(
    @Inject(IApiKeyService) private readonly apiKeyService: IApiKeyService,
    private readonly sessionService: StreamingSessionService,
    private readonly bridgeService: StreamingAudioBridgeService,
    private readonly sessionBinding: StreamSessionTenantBindingService,
    @Optional() private readonly sessionMetadataService?: SttCompatSessionMetadataService,
  ) {}

  async handleConnection(client: WebSocket, request: IncomingMessage): Promise<void> {
    const url = new URL(request.url ?? '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    const rawKey = this.apiKeyService.extractApiKeyFromWebSocket({ headers: request.headers, url: request.url });

    if (!sessionId || !rawKey) {
      this.reject(client, sessionId, 'missing session or API key');
      return;
    }

    let apiKey;
    try {
      apiKey = await this.apiKeyService.authenticateByRawKey(rawKey, request.socket.remoteAddress);
    } catch (error) {
      this.logger.warn({
        message: 'Legacy STT WebSocket authentication failed',
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.reject(client, sessionId, 'invalid API key');
      return;
    }

    let tenantId: string | null;
    try {
      tenantId = await this.sessionBinding.lookup(sessionId);
    } catch (error) {
      this.logger.warn({
        message: 'Legacy STT WebSocket tenant lookup failed',
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.reject(client, sessionId, 'session lookup failed');
      return;
    }

    if (!tenantId || tenantId !== apiKey.tenantId) {
      this.reject(client, sessionId, 'session ownership failed');
      return;
    }

    const status = await this.sessionService.getSessionStatus(sessionId).catch((error) => {
      this.logger.warn({
        message: 'Legacy STT WebSocket session lookup failed',
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (!status) {
      this.reject(client, sessionId, 'session does not exist');
      return;
    }

    const meta = await this.sessionBinding.lookupSessionMeta(sessionId).catch(() => null);
    const language = this.sessionMetadataService ? await this.sessionMetadataService.getLanguage(sessionId).catch(() => null) : null;
    const previous = this.sessionsById.get(sessionId);
    if (previous) {
      this.closeSession(previous);
    }

    const session: LegacySession = {
      client,
      sessionId,
      sampleRate: meta?.sampleRate ?? DEFAULT_SAMPLE_RATE,
      sequence: 0,
      language: language ?? undefined,
      metadata: {},
      results: this.bridgeService.subscribeToResults(sessionId, { consumerGroup: 'legacy-stt' }).subscribe({
        next: (message) => this.relayResult(session, message as unknown as Record<string, unknown>),
        error: (error) => {
          this.logger.warn({
            message: 'Legacy STT result stream failed',
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.sendLegacyError(client, sessionId, 'STT result stream failed');
        },
      }),
    };

    this.sessions.set(client, session);
    this.sessionsById.set(sessionId, session);
    client.on('message', (data, isBinary) => {
      void this.handleMessage(session, data, isBinary);
    });
    client.on('close', () => this.handleDisconnect(client));
    this.sendLegacyMessage(client, sessionId, { type: 'connected', session_id: sessionId, timestamp: this.createTimestamp() });
  }

  handleDisconnect(client: WebSocket): void {
    const session = this.sessions.get(client);
    if (!session) {
      return;
    }
    this.closeSession(session);
  }

  onModuleDestroy(): void {
    for (const session of this.sessionsById.values()) {
      session.results.unsubscribe();
    }
    this.sessions.clear();
    this.sessionsById.clear();
  }

  private async handleMessage(session: LegacySession, data: WebSocket.RawData, isBinary: boolean): Promise<void> {
    if (!this.sessions.has(session.client)) {
      return;
    }

    if (!isBinary) {
      const message = this.parseJson(data);
      if (!message) {
        this.sendLegacyError(session.client, session.sessionId, 'Message must be valid JSON');
        return;
      }
      if (message.type === 'ping') {
        this.sendLegacyMessage(session.client, session.sessionId, {
          type: 'pong',
          session_id: session.sessionId,
          timestamp: this.createTimestamp(),
        });
        return;
      }
      if (message.type === 'stop') {
        await this.bridgeService.writeControlCommand(session.sessionId, 'finalize');
        return;
      }
      return;
    }

    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (frame.length < 5 || frame[0] !== AUDIO_FRAME_TYPE) {
      this.sendLegacyError(session.client, session.sessionId, 'Invalid audio frame');
      return;
    }

    const metadataLength = frame.readUInt32BE(1);
    if (metadataLength > MAX_METADATA_BYTES || frame.length < 5 + metadataLength) {
      this.sendLegacyError(session.client, session.sessionId, 'Invalid audio frame metadata');
      return;
    }

    const metadata = frame.subarray(5, 5 + metadataLength).toString('utf8');
    const parsedMetadata = this.parseJson(metadata);
    if (!parsedMetadata) {
      this.sendLegacyError(session.client, session.sessionId, 'Invalid audio frame metadata');
      return;
    }
    if (parsedMetadata.metadata !== undefined) {
      session.metadata = this.asRecord(parsedMetadata.metadata) ?? {};
    }

    const audio = frame.subarray(5 + metadataLength);
    session.sequence += 1;
    await this.bridgeService.writeAudioFrame(session.sessionId, session.sequence, audio, session.sampleRate, 'pcm_s16le', false);
  }

  private relayResult(session: LegacySession, message: Record<string, unknown>): void {
    if (message.type === 'transcript') {
      const metadata = this.resolveMetadata(session, message);
      const chunkId = this.firstPresent(message.chunk_id, message.chunkId, metadata.chunk_id, metadata.chunkId, metadata.other);
      const detectedLanguage = this.firstPresent(
        message.detected_language,
        message.detectedLanguage,
        metadata.detected_language,
        metadata.detectedLanguage,
        session.language,
      );
      const deliveredMetadata =
        detectedLanguage !== undefined && metadata.detected_language === undefined ? { ...metadata, detected_language: detectedLanguage } : metadata;

      this.sendLegacyMessage(session.client, session.sessionId, {
        type: 'transcription',
        text: typeof message.text === 'string' ? message.text : '',
        speaker_id: this.resolveSpeakerId(message),
        is_final: message.isFinal === true || message.is_final === true,
        timestamp: this.resolveTimestamp(message),
        session_id: session.sessionId,
        metadata: deliveredMetadata,
        chunk_id: chunkId ?? null,
        detected_language: detectedLanguage ?? null,
      });
      return;
    }

    if (message.type === 'status') {
      this.sendLegacyMessage(session.client, session.sessionId, {
        ...message,
        session_id: session.sessionId,
      });
      return;
    }

    if (message.type === 'error') {
      this.sendLegacyError(session.client, session.sessionId, typeof message.message === 'string' ? message.message : 'STT server error');
    }
  }

  private resolveMetadata(session: LegacySession, message: Record<string, unknown>): LegacyMetadata {
    const resultMetadata = this.asRecord(message.metadata);
    if (resultMetadata) {
      session.metadata = resultMetadata;
    }
    return resultMetadata ?? session.metadata;
  }

  private resolveSpeakerId(message: Record<string, unknown>): string {
    const speakerId = this.firstPresent(message.speakerId, message.speaker_id, message.speakerLabel);
    return typeof speakerId === 'string' ? speakerId.trim() || 'Unknown' : 'Unknown';
  }

  private firstPresent(...values: unknown[]): unknown {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') {
        return value;
      }
    }
    return undefined;
  }

  private resolveTimestamp(message: Record<string, unknown>): string {
    if (typeof message.timestamp === 'string' && message.timestamp.length > 0) {
      return message.timestamp;
    }
    if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
      return this.createTimestamp(message.timestamp);
    }
    return this.createTimestamp();
  }

  private createTimestamp(epochMs: number = Date.now()): string {
    return new Date(epochMs).toISOString().replace(/\.(\d{3})Z$/, '.$1000');
  }

  private asRecord(value: unknown): LegacyMetadata | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as LegacyMetadata) : null;
  }
  private parseJson(data: WebSocket.RawData | string): LegacyMessage | null {
    try {
      const parsed = JSON.parse(
        typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8'),
      );
      return this.asRecord(parsed) as LegacyMessage | null;
    } catch {
      return null;
    }
  }

  private reject(client: WebSocket, sessionId: string | null, reason: string): void {
    this.logger.warn({ message: 'Legacy STT WebSocket connection rejected', sessionId, reason });
    client.close(AUTH_CLOSE_CODE, AUTH_CLOSE_REASON);
  }

  private closeSession(session: LegacySession): void {
    session.results.unsubscribe();
    this.sessions.delete(session.client);
    if (this.sessionsById.get(session.sessionId) === session) {
      this.sessionsById.delete(session.sessionId);
    }
  }

  private sendLegacyMessage(client: WebSocket, sessionId: string, data: unknown): void {
    this.sendJson(client, { event: 'message', data, sessionId });
  }

  private sendLegacyError(client: WebSocket, sessionId: string, message: string): void {
    this.sendJson(client, {
      event: 'error',
      data: {
        message,
        error: message,
        sessionId,
      },
    });
  }

  private sendJson(client: WebSocket, payload: unknown): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}
