/**
 * @arcaai/vox - SttV2WebSocketClient
 *
 * WebSocket client implementing the stt-v2 streaming protocol.
 *
 * Client → Server:
 *   - Binary PCM frames (Int16 LE, mono)
 *   - JSON: { type: 'audio', seq, data (base64), microphoneId? }
 *   - JSON: { type: 'stop' }
 *   - JSON: { type: 'close' }
 *
 * Server → Client:
 *   - { type: 'transcript', text, startTime, endTime, isFinal, speakerId?, speakerConfidence?, wordTimestamps?, inference? }
 *   - { type: 'status', status, message }
 *   - { type: 'error', code, message }
 *
 * @see SDK-206 Gap Analysis — ASR-R-03
 */

import type { WsAudioFrame, WsErrorMessage, WsStatusMessage, WsTranscriptResult } from '../types/stt-v2';
import type { ISDKLogger } from './logger';

interface DebugTranscriptEntry {
  segment: number;
  speaker: string;
  start: number;
  end: number;
  duration: number;
  inference: number;
}

function debugLogTranscript(source: string, entry: DebugTranscriptEntry): void {
  // Keep a stable debug format for existing tests and tooling.
  // eslint-disable-next-line no-console
  console.log(`[ARCAAI:DEBUG] ${source} Transcript:\n${JSON.stringify(entry, null, 2)}`);
}

/**
 * Options for WebSocket connection
 */
export interface WsConnectOptions {
  /** Connection timeout in ms (default: 10000). Rejects if server doesn't respond in time. */
  timeoutMs?: number;
}

/**
 * Reconnection strategy configuration.
 * When enabled, the client will automatically attempt to reconnect on unexpected disconnects.
 */
export interface WsReconnectOptions {
  /** Enable automatic reconnection (default: false) */
  enabled: boolean;
  /** Maximum number of reconnection attempts (default: 5) */
  maxAttempts?: number;
  /** Base delay in ms between reconnection attempts — uses exponential backoff (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in ms between reconnection attempts (default: 30000) */
  maxDelayMs?: number;
}

/**
 * WebSocket client for STT-V2 real-time audio streaming.
 *
 * Usage:
 * ```typescript
 * const ws = new SttV2WebSocketClient(logger);
 * await ws.connect(wsUrl);
 *
 * ws.onTranscript((t) => console.log(t.text, t.isFinal));
 * ws.onStatus((s) => console.log(s.status, s.message));
 *
 * ws.sendAudioFrame(pcmBuffer);       // binary
 * ws.sendAudioFrameJson(1, base64);   // JSON
 * ws.sendStop();                       // finalize
 * ws.disconnect();
 * ```
 */
export class SttV2WebSocketClient {
  private ws: WebSocket | null = null;
  private logger?: ISDKLogger;
  private _debugMode: boolean;
  private debugSegmentCounter = 0;

  private onTranscriptCb?: (result: WsTranscriptResult) => void;
  private onStatusCb?: (status: WsStatusMessage) => void;
  private onWsErrorCb?: (error: WsErrorMessage) => void;
  private onDisconnectCb?: () => void;
  private onReconnectCb?: (attempt: number) => void;
  private onReconnectFailedCb?: () => void;

  /** Reconnection configuration */
  private reconnectOptions: Required<WsReconnectOptions>;
  /** Number of reconnection attempts since last successful connect */
  private reconnectAttempts = 0;
  /** Last URL used for connect (needed for reconnection) */
  private lastUrl: string | null = null;
  /** Last connect options used (needed for reconnection) */
  private lastConnectOptions?: WsConnectOptions;
  /** Whether the client was intentionally disconnected */
  private intentionalDisconnect = false;
  /** Timer for pending reconnect delay */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether we are currently in a reconnect cycle */
  private isReconnecting = false;

  constructor(logger?: ISDKLogger, reconnect?: WsReconnectOptions, debugMode?: boolean) {
    this.logger = logger;
    this._debugMode = debugMode ?? false;
    this.reconnectOptions = {
      enabled: reconnect?.enabled ?? false,
      maxAttempts: reconnect?.maxAttempts ?? 5,
      baseDelayMs: reconnect?.baseDelayMs ?? 1000,
      maxDelayMs: reconnect?.maxDelayMs ?? 30_000,
    };
  }

  /**
   * Connect to the stt-v2 WebSocket endpoint.
   * Resolves when connection is open; rejects on failure or timeout.
   *
   * @param url - WebSocket URL
   * @param options - Optional settings (timeoutMs defaults to 10000)
   */
  connect(url: string, options?: WsConnectOptions): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket already connected. Call disconnect() first.'));
    }

    const timeoutMs = options?.timeoutMs ?? 10_000;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const safeUrl = SttV2WebSocketClient.stripQueryParams(url);
      this.logger?.debug('Connecting to stt-v2 WebSocket', {
        operation: 'connect',
        component: 'SttV2WebSocketClient',
        attributes: { url: safeUrl, timeoutMs },
      });

      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      const cleanup = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.logger?.error('WebSocket connection timed out', {
            operation: 'connect',
            component: 'SttV2WebSocketClient',
            attributes: { url, timeoutMs },
          });
          ws.onopen = null;
          ws.onclose = null;
          ws.onerror = null;
          ws.close();
          this.ws = null;
          reject(new Error(`WebSocket connection timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      ws.onopen = () => {
        if (!settled) {
          settled = true;
          cleanup();
          this.ws = ws;
          this.lastUrl = url;
          this.lastConnectOptions = options;
          if (!this.isReconnecting) {
            this.reconnectAttempts = 0;
          }
          this.intentionalDisconnect = false;
          this.logger?.info('WebSocket connected', {
            operation: 'connect',
            component: 'SttV2WebSocketClient',
            success: true,
          });
          resolve();
        }
      };

      ws.onerror = () => {
        this.logger?.error('WebSocket connection error', {
          operation: 'connect',
          component: 'SttV2WebSocketClient',
        });
      };

      ws.onclose = (event) => {
        cleanup();
        const wasConnected = this.ws !== null;
        this.ws = null;

        this.logger?.debug('WebSocket closed', {
          operation: 'onclose',
          component: 'SttV2WebSocketClient',
          attributes: { code: event.code, reason: event.reason },
        });

        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket connection failed (code: ${event.code})`));
        } else if (wasConnected) {
          this.onDisconnectCb?.();

          // Auto-reconnect on unexpected disconnect
          if (this.reconnectOptions.enabled && !this.intentionalDisconnect) {
            this.attemptReconnect();
          }
        }
      };

      ws.onmessage = (event) => {
        this.handleMessage(event);
      };
    });
  }

  /**
   * Send raw PCM audio buffer (Int16 LE, mono).
   */
  sendAudioFrame(buffer: ArrayBuffer): void {
    this.requireConnection();
    this.ws!.send(buffer);
  }

  /**
   * Send JSON-encoded audio frame.
   */
  sendAudioFrameJson(seq: number, data: string, microphoneId?: string): void {
    this.requireConnection();
    const frame: WsAudioFrame = { type: 'audio', seq, data };
    if (microphoneId) {
      frame.microphoneId = microphoneId;
    }
    this.ws!.send(JSON.stringify(frame));
  }

  /**
   * Send stop signal — tells server to finalize current transcription.
   */
  sendStop(): void {
    this.requireConnection();
    this.ws!.send(JSON.stringify({ type: 'stop' }));
  }

  /**
   * Send close signal — tells server to close the session.
   */
  sendClose(): void {
    this.requireConnection();
    this.ws!.send(JSON.stringify({ type: 'close' }));
  }

  /**
   * Disconnect the WebSocket connection.
   * Safe to call when not connected.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.cancelReconnect();

    if (this.ws) {
      this.logger?.debug('Disconnecting WebSocket', {
        operation: 'disconnect',
        component: 'SttV2WebSocketClient',
      });

      const ws = this.ws;
      this.ws = null;
      ws.onclose = null; // prevent re-triggering
      ws.close(1000, 'Client disconnect');

      this.onDisconnectCb?.();
    }
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // =========================================================================
  // Event registration
  // =========================================================================

  onTranscript(cb: (result: WsTranscriptResult) => void): void {
    this.onTranscriptCb = cb;
  }

  onStatus(cb: (status: WsStatusMessage) => void): void {
    this.onStatusCb = cb;
  }

  onWsError(cb: (error: WsErrorMessage) => void): void {
    this.onWsErrorCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.onDisconnectCb = cb;
  }

  /** Called when a reconnection attempt starts. Provides the attempt number. */
  onReconnect(cb: (attempt: number) => void): void {
    this.onReconnectCb = cb;
  }

  /** Called when all reconnection attempts have been exhausted. */
  onReconnectFailed(cb: () => void): void {
    this.onReconnectFailedCb = cb;
  }

  // =========================================================================
  // Reconnection
  // =========================================================================

  /** Get current reconnection attempt count */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * Acknowledge that the connection is stable (e.g. after receiving first transcript).
   * Resets the reconnect counter so future disconnects get a fresh set of attempts.
   */
  acknowledgeConnection(): void {
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
  }

  /** Cancel any pending reconnection timer */
  cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
  }

  /**
   * Attempt to reconnect using exponential backoff.
   * Called automatically on unexpected disconnects when reconnect is enabled.
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.reconnectOptions.maxAttempts) {
      this.isReconnecting = false;
      this.logger?.error('WebSocket reconnection failed — max attempts exhausted', {
        operation: 'attemptReconnect',
        component: 'SttV2WebSocketClient',
        attributes: { maxAttempts: this.reconnectOptions.maxAttempts },
      });
      this.onReconnectFailedCb?.();
      return;
    }

    if (!this.lastUrl) {
      this.isReconnecting = false;
      this.logger?.error('Cannot reconnect — no previous URL stored', {
        operation: 'attemptReconnect',
        component: 'SttV2WebSocketClient',
      });
      this.onReconnectFailedCb?.();
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const exponentialDelay = Math.min(this.reconnectOptions.baseDelayMs * Math.pow(2, this.reconnectAttempts - 1), this.reconnectOptions.maxDelayMs);
    const jitter = Math.random() * exponentialDelay * 0.5;
    const delay = Math.round(exponentialDelay + jitter);

    this.logger?.debug(`WebSocket reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.reconnectOptions.maxAttempts})`, {
      operation: 'attemptReconnect',
      component: 'SttV2WebSocketClient',
      attributes: {
        attempt: this.reconnectAttempts,
        maxAttempts: this.reconnectOptions.maxAttempts,
        delayMs: delay,
      },
    });

    this.onReconnectCb?.(this.reconnectAttempts);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (this.intentionalDisconnect) return;

      this.connect(this.lastUrl!, this.lastConnectOptions).catch((error) => {
        this.logger?.warn('WebSocket reconnection attempt failed', {
          operation: 'attemptReconnect',
          component: 'SttV2WebSocketClient',
          error: error as Error,
          attributes: { attempt: this.reconnectAttempts },
        });
        // The onclose handler will trigger the next attempt
      });
    }, delay);
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private static stripQueryParams(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      return url.split('?')[0] ?? url;
    }
  }

  private requireConnection(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected. Call connect() first.');
    }
  }

  private static normalizeTranscript(msg: Record<string, unknown>): WsTranscriptResult | null {
    const startTime = typeof msg.startTime === 'number' ? msg.startTime : typeof msg.start_time === 'number' ? msg.start_time : null;
    const endTime = typeof msg.endTime === 'number' ? msg.endTime : typeof msg.end_time === 'number' ? msg.end_time : null;

    let isFinal: boolean | null = null;
    if (typeof msg.isFinal === 'boolean') {
      isFinal = msg.isFinal;
    } else if (typeof msg.is_final === 'boolean') {
      isFinal = msg.is_final;
    } else if (msg.is_final === '1') {
      isFinal = true;
    } else if (msg.is_final === '0') {
      isFinal = false;
    }

    if (typeof msg.text !== 'string' || startTime == null || endTime == null || isFinal == null) {
      return null;
    }

    const normalized: WsTranscriptResult = {
      type: 'transcript',
      text: msg.text,
      startTime,
      endTime,
      isFinal,
    };

    const speakerId = typeof msg.speakerId === 'string' ? msg.speakerId : typeof msg.speaker_id === 'string' ? msg.speaker_id : undefined;
    if (speakerId && speakerId.trim().length > 0) {
      normalized.speakerId = speakerId;
    }

    const speakerLabel =
      typeof msg.speakerLabel === 'string' ? msg.speakerLabel : typeof msg.speaker_label === 'string' ? msg.speaker_label : undefined;
    if (speakerLabel && speakerLabel.trim().length > 0) {
      normalized.speakerLabel = speakerLabel;
    }

    const rawSpeakerConfidence =
      typeof msg.speakerConfidence === 'number'
        ? msg.speakerConfidence
        : typeof msg.speaker_confidence === 'number'
          ? msg.speaker_confidence
          : typeof msg.speaker_confidence === 'string'
            ? Number.parseFloat(msg.speaker_confidence)
            : undefined;
    if (typeof rawSpeakerConfidence === 'number' && Number.isFinite(rawSpeakerConfidence)) {
      normalized.speakerConfidence = rawSpeakerConfidence;
    }

    const rawSpeakerEmbedding = Array.isArray(msg.speakerEmbedding)
      ? msg.speakerEmbedding
      : Array.isArray(msg.speaker_embedding)
        ? msg.speaker_embedding
        : undefined;
    if (rawSpeakerEmbedding) {
      const speakerEmbedding = rawSpeakerEmbedding.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      if (speakerEmbedding.length > 0) {
        normalized.speakerEmbedding = speakerEmbedding;
      }
    }

    const speakerFeatures =
      typeof msg.speakerFeatures === 'object' && msg.speakerFeatures
        ? (msg.speakerFeatures as Record<string, unknown>)
        : typeof msg.speaker_features === 'object' && msg.speaker_features
          ? (msg.speaker_features as Record<string, unknown>)
          : undefined;
    if (speakerFeatures) {
      normalized.speakerFeatures = speakerFeatures;
    }

    const rawWordTimestamps = Array.isArray(msg.wordTimestamps)
      ? msg.wordTimestamps
      : Array.isArray(msg.word_timestamps)
        ? msg.word_timestamps
        : undefined;
    if (rawWordTimestamps && rawWordTimestamps.length > 0) {
      const wordTimestamps = rawWordTimestamps
        .filter(
          (wt): wt is Record<string, unknown> =>
            typeof wt === 'object' &&
            wt !== null &&
            typeof (wt as Record<string, unknown>).word === 'string' &&
            typeof (wt as Record<string, unknown>).start === 'number' &&
            typeof (wt as Record<string, unknown>).end === 'number',
        )
        .map((wt) => ({
          word: wt.word as string,
          start: wt.start as number,
          end: wt.end as number,
          confidence: typeof wt.confidence === 'number' && Number.isFinite(wt.confidence) ? wt.confidence : 1.0,
        }));
      if (wordTimestamps.length > 0) {
        normalized.wordTimestamps = wordTimestamps;
      }
    }

    const rawInference = typeof msg.inference === 'number' ? msg.inference : typeof msg.inference_time === 'number' ? msg.inference_time : undefined;
    if (typeof rawInference === 'number' && Number.isFinite(rawInference)) {
      normalized.inference = rawInference;
    }

    return normalized;
  }

  private static isValidStatus(msg: unknown): msg is WsStatusMessage {
    if (!msg || typeof msg !== 'object') {
      return false;
    }
    const candidate = msg as { status?: unknown; message?: unknown };
    return typeof candidate.status === 'string' && typeof candidate.message === 'string';
  }

  private static isValidError(msg: unknown): msg is WsErrorMessage {
    if (!msg || typeof msg !== 'object') {
      return false;
    }
    const candidate = msg as { code?: unknown; message?: unknown };
    return typeof candidate.code === 'string' && typeof candidate.message === 'string';
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') {
      this.logger?.warn('Received non-string WebSocket message', {
        operation: 'handleMessage',
        component: 'SttV2WebSocketClient',
      });
      return;
    }

    try {
      const msg = JSON.parse(event.data) as Record<string, unknown>;

      switch (msg.type) {
        case 'transcript':
          {
            const transcript = SttV2WebSocketClient.normalizeTranscript(msg);
            if (!transcript) {
              this.logger?.warn('Invalid transcript message — missing required fields', {
                operation: 'handleMessage',
                component: 'SttV2WebSocketClient',
                attributes: { keys: Object.keys(msg) },
              });
              return;
            }
            if (this._debugMode && transcript.isFinal) {
              this.debugSegmentCounter++;
              const startSec = transcript.startTime;
              const endSec = transcript.endTime;
              const entry: DebugTranscriptEntry = {
                segment: this.debugSegmentCounter,
                speaker: transcript.speakerId ?? 'speaker-1',
                start: startSec,
                end: endSec,
                duration: endSec - startSec,
                inference: transcript.inference ?? 0,
              };
              debugLogTranscript('SttV2WebSocket', entry);
            }
            this.onTranscriptCb?.(transcript);
          }
          break;
        case 'status':
          if (!SttV2WebSocketClient.isValidStatus(msg)) {
            this.logger?.warn('Invalid status message — missing required fields', {
              operation: 'handleMessage',
              component: 'SttV2WebSocketClient',
              attributes: { keys: Object.keys(msg) },
            });
            return;
          }
          this.onStatusCb?.(msg);
          break;
        case 'error':
          if (!SttV2WebSocketClient.isValidError(msg)) {
            this.logger?.warn('Invalid error message — missing required fields', {
              operation: 'handleMessage',
              component: 'SttV2WebSocketClient',
              attributes: { keys: Object.keys(msg) },
            });
            return;
          }
          this.onWsErrorCb?.(msg);
          break;
        default:
          this.logger?.warn('Unknown WebSocket message type', {
            operation: 'handleMessage',
            component: 'SttV2WebSocketClient',
            attributes: { messageType: String(msg.type ?? 'undefined') },
          });
      }
    } catch (error) {
      this.logger?.error('Failed to parse WebSocket message', {
        operation: 'handleMessage',
        component: 'SttV2WebSocketClient',
        error: error as Error,
      });
    }
  }
}
