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

import type {
  WsAudioFrame,
  WsErrorMessage,
  WsResumeFailedMessage,
  WsResumeRequest,
  WsResumedMessage,
  WsStatusMessage,
  WsTranscriptResult,
  WsTranscriptWirePayload,
} from '../types/stt-v2';
import type { ISDKLogger } from './logger';

interface DebugTranscriptEntry {
  segment: number;
  speaker: string;
  start: number;
  end: number;
  duration: number;
  inference: number;
}

function debugLogTranscript(logger: ISDKLogger | undefined, source: string, entry: DebugTranscriptEntry): void {
  // TASK-266 W0-13: route through SDKLogger.debug so the entry passes through
  // the redactPHI pipeline (and any user-configured transports) instead of
  // emitting raw PHI to the browser console. The structured `entry` lives in
  // `attributes.entry` so consumers can parse it without regex-splitting.
  logger?.debug(`[ARCAAI:DEBUG] ${source} Transcript:\n${JSON.stringify(entry, null, 2)}`, {
    operation: 'debugLogTranscript',
    component: 'SttV2WebSocketClient',
    attributes: { entry },
  });
}

/**
 * Options for WebSocket connection
 */
export interface WsConnectOptions {
  /** Connection timeout in ms (default: 10000). Rejects if server doesn't respond in time. */
  timeoutMs?: number;
  /**
   * TASK-317 E-4 (AC-10) — explicit tenant claim for this connection. When
   * `requireTenantClaim` is set and this is absent, the claim is resolved
   * from the URL (`tenantId` / `tenant` query params) instead.
   */
  tenantClaim?: string;
  /**
   * Fail-closed tenant-claim guard. When enforced, `connect()` rejects
   * (before opening any socket) unless a tenant claim is resolvable from
   * `tenantClaim` or the URL.
   *
   * TASK-317 E-4 (AC-10) introduced this as an opt-in (default `false`).
   * TASK-320 B5 flips the EFFECTIVE default to `true` (fail-closed by
   * default) — connections without a resolvable tenant claim now reject.
   * Callers that genuinely need to skip the check must opt out explicitly
   * with `requireTenantClaim: false`. The SDK's own streaming flow always
   * supplies a tenant claim via `StreamingSessionManager.getWebSocketUrl()`
   * (it appends `?tenantId=`), so it keeps working unchanged.
   */
  requireTenantClaim?: boolean;
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
  /**
   * Callback invoked before each reconnect attempt (TASK-298 D-18). Must
   * return a new single-use stream ticket. The previous ticket is consumed
   * by the gateway on the first WS open, so reconnects MUST mint a fresh
   * ticket. When the callback returns null / throws, the attempt is aborted.
   */
  refreshTicket?: () => Promise<string>;
}

/**
 * Bounded queue + backpressure configuration (TASK-298 D-15 / M-WS-6).
 *
 * Without these limits, `audioQueue.length` and `ws.bufferedAmount` would
 * grow unboundedly under network pressure. We drop oldest frames once the
 * queue exceeds `maxQueueSize` and skip sending while `bufferedAmount`
 * exceeds `bufferedAmountHighWatermark`.
 */
export interface WsBackpressureOptions {
  /** Maximum number of audio frames buffered locally before the oldest is dropped. */
  maxQueueSize?: number;
  /**
   * Bytes threshold for `ws.bufferedAmount`. When exceeded, the next
   * `sendAudioFrame` call drops the frame and emits a backpressure event.
   */
  bufferedAmountHighWatermark?: number;
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
  /** Default bounded queue size (TASK-298 D-15). */
  static readonly DEFAULT_MAX_QUEUE_SIZE = 200;
  /** Default bufferedAmount watermark — 1 MiB (TASK-298 D-15). */
  static readonly DEFAULT_BUFFERED_AMOUNT_HIGH_WATERMARK = 1 * 1024 * 1024;

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
  /** Emitted when a reconnect attempt genuinely re-opens the socket (TASK-461 C6-02). */
  private onReconnectedCb?: () => void;
  /** Emitted whenever a frame is dropped due to backpressure (TASK-298 D-15). */
  private onBackpressureDropCb?: (reason: 'queue_full' | 'buffered_amount_high') => void;

  /** Reconnection configuration */
  private reconnectOptions: Required<Omit<WsReconnectOptions, 'refreshTicket'>> & {
    refreshTicket: (() => Promise<string>) | null;
  };
  /** Backpressure configuration (TASK-298 D-15). */
  private backpressureOptions: Required<WsBackpressureOptions>;
  /** Number of frames dropped since last connect (D-15). */
  private droppedFrameCount = 0;
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
  /**
   * Highest transcript `seq` the client has received (TASK-298 D-17). Sent
   * as `lastSeq` in the resume handshake on every reconnect.
   */
  private lastReceivedSeq = 0;
  /**
   * Session id captured from the URL on first connect; used as the
   * `sessionId` field in the resume handshake.
   */
  private currentSessionId: string | null = null;

  constructor(logger?: ISDKLogger, reconnect?: WsReconnectOptions, debugMode?: boolean, backpressure?: WsBackpressureOptions) {
    this.logger = logger;
    this._debugMode = debugMode ?? false;
    this.reconnectOptions = {
      enabled: reconnect?.enabled ?? false,
      maxAttempts: reconnect?.maxAttempts ?? 5,
      baseDelayMs: reconnect?.baseDelayMs ?? 1000,
      maxDelayMs: reconnect?.maxDelayMs ?? 30_000,
      refreshTicket: reconnect?.refreshTicket ?? null,
    };
    this.backpressureOptions = {
      maxQueueSize: backpressure?.maxQueueSize ?? SttV2WebSocketClient.DEFAULT_MAX_QUEUE_SIZE,
      bufferedAmountHighWatermark: backpressure?.bufferedAmountHighWatermark ?? SttV2WebSocketClient.DEFAULT_BUFFERED_AMOUNT_HIGH_WATERMARK,
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

    // TASK-317 E-4 (AC-10) + TASK-320 B5 — fail-closed tenant-claim guard.
    // The guard is now ON BY DEFAULT (`requireTenantClaim` defaults to `true`);
    // callers opt out explicitly with `requireTenantClaim: false`. Reject
    // BEFORE creating a socket when enforcement is active and no claim resolves.
    const requireTenantClaim = options?.requireTenantClaim ?? true;
    if (requireTenantClaim && SttV2WebSocketClient.resolveTenantClaim(url, options) === null) {
      this.logger?.error('WebSocket connect blocked: no tenant claim resolvable from connect context', {
        operation: 'connect',
        component: 'SttV2WebSocketClient',
        attributes: { url: SttV2WebSocketClient.stripQueryParams(url) },
      });
      return Promise.reject(new Error('WebSocket connect blocked: no tenant claim resolvable from connect context'));
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
          this.currentSessionId = SttV2WebSocketClient.parseSessionId(url) ?? this.currentSessionId;
          this.droppedFrameCount = 0;
          const wasReconnecting = this.isReconnecting;
          if (!this.isReconnecting) {
            this.reconnectAttempts = 0;
          }
          this.intentionalDisconnect = false;
          this.logger?.info('WebSocket connected', {
            operation: 'connect',
            component: 'SttV2WebSocketClient',
            success: true,
          });
          if (wasReconnecting && this.currentSessionId) {
            this.sendResumeHandshake(ws, this.currentSessionId, this.lastReceivedSeq);
          }
          if (wasReconnecting) {
            // TASK-461 C6-02 — the transport genuinely re-opened after a drop.
            // Signal reconnect SUCCESS so consumers leave their 'reconnecting'
            // UX and read as live again. Distinct from `onReconnect`, which
            // fires at attempt-start during backoff (socket not yet back).
            this.onReconnectedCb?.();
          }
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
   * Send raw PCM audio (Int16 LE, mono) as a binary frame.
   *
   * Accepts an `ArrayBuffer` or any `ArrayBufferView` (e.g. `Int16Array`) —
   * `WebSocket.send` handles views natively, so callers can pass their
   * typed-array view directly without slice-copying the underlying buffer
   * (TASK-351 P0-5, zero-copy hot path).
   *
   * TASK-298 D-15: drops the frame and emits a backpressure event when
   * `ws.bufferedAmount` exceeds the configured high-watermark. Returns
   * `false` when the frame was dropped, `true` otherwise.
   */
  sendAudioFrame(data: ArrayBuffer | ArrayBufferView): boolean {
    this.requireConnection();
    if (this.shouldDropForBufferedAmount()) {
      this.dropFrameDueToBackpressure('buffered_amount_high');
      return false;
    }
    this.ws!.send(data);
    return true;
  }

  /**
   * Send JSON-encoded audio frame.
   *
   * TASK-298 D-15: same backpressure policy as `sendAudioFrame`.
   */
  sendAudioFrameJson(seq: number, data: string, microphoneId?: string): boolean {
    this.requireConnection();
    if (this.shouldDropForBufferedAmount()) {
      this.dropFrameDueToBackpressure('buffered_amount_high');
      return false;
    }
    const frame: WsAudioFrame = { type: 'audio', seq, data };
    if (microphoneId) {
      frame.microphoneId = microphoneId;
    }
    this.ws!.send(JSON.stringify(frame));
    return true;
  }

  /** Count of frames dropped due to backpressure since last connect (D-15). */
  getDroppedFrameCount(): number {
    return this.droppedFrameCount;
  }

  /** Highest transcript `seq` received from the server (D-17). */
  getLastReceivedSeq(): number {
    return this.lastReceivedSeq;
  }

  /** Register a callback invoked when a frame is dropped due to backpressure (D-15). */
  onBackpressureDrop(cb: (reason: 'queue_full' | 'buffered_amount_high') => void): void {
    this.onBackpressureDropCb = cb;
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

  /**
   * Called when a reconnection attempt has genuinely re-opened the socket
   * (TASK-461 C6-02). Fires on the reconnect open only — never on the initial
   * connect — so consumers can transition a 'reconnecting' surface back to
   * live. Contrast `onReconnect`, which fires at attempt-start during backoff.
   */
  onReconnected(cb: () => void): void {
    this.onReconnectedCb = cb;
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

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      if (this.intentionalDisconnect) return;

      let reconnectUrl = this.lastUrl!;
      if (this.reconnectOptions.refreshTicket) {
        try {
          const freshTicket = await this.reconnectOptions.refreshTicket();
          reconnectUrl = SttV2WebSocketClient.replaceTicketParam(reconnectUrl, freshTicket);
          this.lastUrl = reconnectUrl;
        } catch (err) {
          this.logger?.error('Failed to refresh stream ticket — aborting reconnect (TASK-298 D-18)', {
            operation: 'attemptReconnect',
            component: 'SttV2WebSocketClient',
            error: err as Error,
            attributes: { attempt: this.reconnectAttempts },
          });
          this.isReconnecting = false;
          this.onReconnectFailedCb?.();
          return;
        }
      }

      this.connect(reconnectUrl, this.lastConnectOptions).catch((error) => {
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

  /**
   * TASK-317 E-4 (AC-10) — resolve the tenant claim for a connection. Prefers
   * an explicit `options.tenantClaim`, then falls back to the URL `tenantId`
   * or `tenant` query param. Returns null when no non-empty claim is found, so
   * the caller can fail-closed. Empty/whitespace values never count as a claim.
   */
  private static resolveTenantClaim(url: string, options?: WsConnectOptions): string | null {
    const explicit = options?.tenantClaim?.trim();
    if (explicit) return explicit;

    let raw: string | null = null;
    try {
      const parsed = new URL(url);
      raw = parsed.searchParams.get('tenantId') ?? parsed.searchParams.get('tenant');
    } catch {
      const match = url.match(/[?&](?:tenantId|tenant)=([^&]+)/);
      raw = match?.[1] ? decodeURIComponent(match[1]) : null;
    }
    const claim = raw?.trim();
    return claim ? claim : null;
  }

  private requireConnection(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected. Call connect() first.');
    }
  }

  /**
   * TASK-461 C6-04 — tolerant `isFinal` coercion. Accepts a boolean, the
   * numbers 1/0, or the strings '1'/'0'; returns null when unparseable so the
   * caller can fall through to the other casing (and ultimately default false).
   */
  private static coerceIsFinal(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1') return true;
    if (value === 0 || value === '0') return false;
    return null;
  }

  private static normalizeTranscript(msg: WsTranscriptWirePayload): WsTranscriptResult | null {
    // TASK-461 C6-04 — `text` is the only field a caption cannot survive
    // without, so a payload with no string `text` is genuinely unusable and is
    // dropped. Everything else DEGRADES (sensible defaults) rather than
    // discarding the whole transcript: an omitted `start_time` or a numeric
    // `is_final` must never cost the clinician a caption.
    if (typeof msg.text !== 'string') {
      return null;
    }

    const startTime = typeof msg.startTime === 'number' ? msg.startTime : typeof msg.start_time === 'number' ? msg.start_time : 0;
    const endTime = typeof msg.endTime === 'number' ? msg.endTime : typeof msg.end_time === 'number' ? msg.end_time : 0;

    // Absent/unparseable isFinal degrades to a partial (false) — never a
    // premature final that would prematurely commit a live row.
    const isFinal = SttV2WebSocketClient.coerceIsFinal(msg.isFinal) ?? SttV2WebSocketClient.coerceIsFinal(msg.is_final) ?? false;

    const normalized: WsTranscriptResult = {
      type: 'transcript',
      text: msg.text,
      startTime,
      endTime,
      isFinal,
    };

    // TASK-298 D-17: capture server-assigned monotonic sequence number so
    // the client can resume after a reconnect.
    if (typeof msg.seq === 'number' && Number.isFinite(msg.seq)) {
      normalized.seq = msg.seq;
    }

    // TASK-351 P1-1: committed-prefix length on partials (dual-cased like
    // the other fields; additive — absent on older servers).
    const rawStableChars =
      typeof msg.stableChars === 'number' ? msg.stableChars : typeof msg.stable_chars === 'number' ? msg.stable_chars : undefined;
    if (typeof rawStableChars === 'number' && Number.isFinite(rawStableChars) && rawStableChars >= 0) {
      normalized.stableChars = Math.floor(rawStableChars);
    }

    // TASK-351 P1-1 follow-up: utterance ordinal (dual-cased, additive).
    const rawUtteranceIndex =
      typeof msg.utteranceIndex === 'number' ? msg.utteranceIndex : typeof msg.utterance_index === 'number' ? msg.utterance_index : undefined;
    if (typeof rawUtteranceIndex === 'number' && Number.isFinite(rawUtteranceIndex) && rawUtteranceIndex >= 0) {
      normalized.utteranceIndex = Math.floor(rawUtteranceIndex);
    }

    // TASK-351 P1-1 follow-up: result kind — the gateway relays it as
    // `resultType`; raw wire payloads carry it as `type` (segment|gloss).
    // The WS envelope's own `type: 'transcript'` fails the guard, so only
    // genuine segment/gloss markers are accepted.
    const rawResultType = typeof msg.resultType === 'string' ? msg.resultType : typeof msg.type === 'string' ? msg.type : undefined;
    if (rawResultType === 'segment' || rawResultType === 'gloss') {
      normalized.resultType = rawResultType;
    }

    const englishText = typeof msg.englishText === 'string' ? msg.englishText : typeof msg.english_text === 'string' ? msg.english_text : undefined;
    if (englishText && englishText.trim().length > 0) {
      normalized.englishText = englishText;
    }

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
              debugLogTranscript(this.logger, 'SttV2WebSocket', entry);
            }
            // TASK-298 D-17: track the highest seen seq.
            if (typeof transcript.seq === 'number' && transcript.seq > this.lastReceivedSeq) {
              this.lastReceivedSeq = transcript.seq;
            }
            this.onTranscriptCb?.(transcript);
          }
          break;
        case 'resumed': {
          const resumed = msg as unknown as WsResumedMessage;
          this.logger?.info('Server accepted resume handshake', {
            operation: 'handleMessage',
            component: 'SttV2WebSocketClient',
            attributes: { fromSeq: resumed.fromSeq, sessionId: resumed.sessionId },
          });
          break;
        }
        case 'resume_failed': {
          const failed = msg as unknown as WsResumeFailedMessage;
          this.logger?.warn('Server rejected resume handshake — transcript history lost', {
            operation: 'handleMessage',
            component: 'SttV2WebSocketClient',
            attributes: {
              reason: failed.reason,
              minAvailableSeq: failed.minAvailableSeq,
              sessionId: failed.sessionId,
            },
          });
          this.lastReceivedSeq = 0;
          this.onWsErrorCb?.({
            type: 'error',
            code: 'RESUME_FAILED',
            message: `Server rejected resume handshake: ${failed.reason}`,
          });
          break;
        }
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

  // =========================================================================
  // TASK-298 D-15 / D-17 / D-18 helpers
  // =========================================================================

  /**
   * D-15: Decide whether to drop the next outbound frame because the WS
   * buffer is over the high-watermark. Reading `bufferedAmount` on closed
   * sockets throws on some platforms, so we guard against that.
   */
  private shouldDropForBufferedAmount(): boolean {
    if (!this.ws) return false;
    const buffered = (this.ws as { bufferedAmount?: number }).bufferedAmount ?? 0;
    return buffered >= this.backpressureOptions.bufferedAmountHighWatermark;
  }

  private dropFrameDueToBackpressure(reason: 'queue_full' | 'buffered_amount_high'): void {
    this.droppedFrameCount++;
    this.logger?.warn('Dropping audio frame due to backpressure (TASK-298 D-15)', {
      operation: 'sendAudioFrame',
      component: 'SttV2WebSocketClient',
      attributes: {
        reason,
        bufferedAmount: (this.ws as { bufferedAmount?: number } | null)?.bufferedAmount,
        droppedFrameCount: this.droppedFrameCount,
        highWatermark: this.backpressureOptions.bufferedAmountHighWatermark,
      },
    });
    this.onBackpressureDropCb?.(reason);
  }

  /** Extract `sessionId` query param from a WS URL (D-17). */
  private static parseSessionId(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.searchParams.get('sessionId');
    } catch {
      const match = url.match(/[?&]sessionId=([^&]+)/);
      return match?.[1] ? decodeURIComponent(match[1]) : null;
    }
  }

  /**
   * Replace (or insert) the `ticket=...` query param in a WS URL with a
   * freshly-issued value. Used on reconnect (D-18). The previous ticket is
   * one-shot consumed on the gateway, so reusing the URL verbatim would
   * cause a 4401 close.
   */
  private static replaceTicketParam(url: string, ticket: string): string {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set('ticket', ticket);
      return parsed.toString();
    } catch {
      if (/[?&]ticket=[^&]*/.test(url)) {
        return url.replace(/([?&])ticket=[^&]*/, `$1ticket=${encodeURIComponent(ticket)}`);
      }
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}ticket=${encodeURIComponent(ticket)}`;
    }
  }

  /** Send the JSON resume handshake immediately after a reconnect (D-17). */
  private sendResumeHandshake(ws: WebSocket, sessionId: string, lastSeq: number): void {
    const handshake: WsResumeRequest = { type: 'resume', sessionId, lastSeq };
    try {
      ws.send(JSON.stringify(handshake));
      this.logger?.debug('Sent resume handshake to server (TASK-298 D-17)', {
        operation: 'sendResumeHandshake',
        component: 'SttV2WebSocketClient',
        attributes: { sessionId, lastSeq },
      });
    } catch (err) {
      this.logger?.warn('Failed to send resume handshake', {
        operation: 'sendResumeHandshake',
        component: 'SttV2WebSocketClient',
        error: err as Error,
      });
    }
  }
}
