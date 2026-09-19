/**
 * @arcaai/vox - SttWebSocketClient
 *
 * WebSocket client implementing the stt streaming protocol.
 *
 * Client → Server:
 *   - Binary PCM frames (Int16 LE, mono)
 *   - JSON: { type: 'audio', seq, data (base64), microphoneId? }
 *   - JSON: { type: 'stop' }
 *   - JSON: { type: 'close' }
 *
 * Server → Client:
 *   - { type: 'ready', sessionId, fromSeq?, sessionEpochMs? }   ← FIRST frame; gate the first send on it
 *   - { type: 'transcript', text, startTime, endTime, isFinal, speakerId?, speakerConfidence?, wordTimestamps?, inference? }
 *   - { type: 'status', status, message }
 *   - { type: 'gap', reason, sessionId, droppedPartials? | droppedSeq? }
 *   - { type: 'error', code, message }
 *
 * @see SDK-206 Gap Analysis — ASR-R-03
 */

import type {
  WsAudioFrame,
  WsErrorMessage,
  WsGapMessage,
  WsReadyMessage,
  WsMetadataMessage,
  WsMetadataSpan,
  WsResumeFailedMessage,
  WsResumeRequest,
  WsResumedMessage,
  WsStatusMessage,
  WsTranscriptResult,
  WsTranscriptWirePayload,
} from '../types/stt';
import type { ISDKLogger } from './logger';

/**
 * TASK-951 — hard ceiling on ONE {@link SttWebSocketClient.setMetadata} object, in bytes of
 * JSON. The gateway enforces the same number and answers `METADATA_TOO_LARGE` above it; this
 * copy exists so the SDK can refuse at the call site instead of on an async error frame.
 */
export const MAX_STREAM_METADATA_BYTES = 2048;

interface DebugTranscriptEntry {
  segment: number;
  speaker: string;
  start: number;
  end: number;
  duration: number;
  inference: number;
}

function debugLogTranscript(logger: ISDKLogger | undefined, source: string, entry: DebugTranscriptEntry): void {
  // Route through SDKLogger.debug so the entry passes through
  // the redactPHI pipeline (and any user-configured transports) instead of
  // emitting raw PHI to the browser console. The structured `entry` lives in
  // `attributes.entry` so consumers can parse it without regex-splitting.
  logger?.debug(`[ARCAAI:DEBUG] ${source} Transcript:\n${JSON.stringify(entry, null, 2)}`, {
    operation: 'debugLogTranscript',
    component: 'SttWebSocketClient',
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
   * Explicit tenant claim for this connection. When
   * `requireTenantClaim` is set and this is absent, the claim is resolved
   * from the URL (`tenantId` / `tenant` query params) instead.
   */
  tenantClaim?: string;
  /**
   * Fail-closed tenant-claim guard. When enforced, `connect()` rejects
   * (before opening any socket) unless a tenant claim is resolvable from
   * `tenantClaim` or the URL.
   *
   * This started as an opt-in (default `false`); the EFFECTIVE default is
   * now `true` (fail-closed by default) — connections without a resolvable
   * tenant claim now reject.
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
   * Callback invoked before each reconnect attempt. Must
   * return a new single-use stream ticket. The previous ticket is consumed
   * by the gateway on the first WS open, so reconnects MUST mint a fresh
   * ticket. When the callback returns null / throws, the attempt is aborted.
   */
  refreshTicket?: () => Promise<string>;
  // v1-compatibility
  requireTenantClaim?: boolean;
}

/**
 * Bounded queue + backpressure configuration.
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
 * Stop-drain tuning.
 *
 * `stopAndDrain` keeps the socket open after the finalize control frame so a
 * tail final still reaches `onTranscript`. How long it is willing to wait —
 * and whether a `finalizing` progress status may end that wait early — is
 * configuration, not a constant: the wait is user-visible latency on Stop.
 */
export interface WsDrainOptions {
  /**
   * Hard ceiling on the drain wait, in ms (default
   * {@link SttWebSocketClient.DEFAULT_DRAIN_TIMEOUT_MS}). Reached only when no
   * terminal status arrives at all.
   */
  timeoutMs?: number;
  /**
   * Quiet window in ms (default
   * {@link SttWebSocketClient.DEFAULT_DRAIN_QUIET_WINDOW_MS} — `0`, i.e.
   * DISABLED, since TASK-991). Once the server reports `finalizing`, a
   * POSITIVE value resolves the drain after this much silence — every
   * transcript received restarts the window, so the tail is never cut short.
   * `0` (the default) disables the early resolve entirely and waits for a
   * terminal status only — pass a positive value to opt back into the
   * silence heuristic (e.g. because the deployment's finalize is fast enough
   * that a snappier teardown is worth the small risk of cutting the tail).
   */
  quietWindowMs?: number;
}

/**
 * WebSocket client for STT real-time audio streaming.
 *
 * Usage:
 * ```typescript
 * const ws = new SttWebSocketClient(logger);
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
export class SttWebSocketClient {
  /** Default bounded queue size. */
  static readonly DEFAULT_MAX_QUEUE_SIZE = 200;
  /**
   * Bytes of 16 kHz mono Int16 PCM per second of audio — 16000 samples x 2
   * bytes. The constant that turns a `bufferedAmount` into a duration, which is
   * the only unit a backlog is meaningful in.
   */
  static readonly PCM_BYTES_PER_SECOND = 16_000 * 2;

  /**
   * Default bufferedAmount watermark — 128 KiB, about **4.1 s** of audio
   * (TASK-985 M-36).
   *
   * It was 1 MiB, which is ~33 s: a link slow enough to be losing audio could
   * sit a full half-minute behind the room before a single frame was dropped
   * and the clinician saw ANY degraded signal, and the frame dropped at that
   * point is the NEWEST one — the words being spoken now. Four seconds keeps
   * the shed window inside the span a clinician can still remember and repeat,
   * and makes the "audio was lost" signal arrive while it is still actionable.
   *
   * It is a default, not a policy: pass `bufferedAmountHighWatermark` to widen
   * it for a deliberately lossy link.
   */
  static readonly DEFAULT_BUFFERED_AMOUNT_HIGH_WATERMARK = 128 * 1024;
  /**
   * Default stop-drain ceiling — the fallback for a server that never
   * answers at all, not the expected path (the drain normally ends on the
   * terminal `closed`/`cancelled` status, arriving long before this fires).
   *
   * RAISED from 1500ms (TASK-991). That value was reasoned from the terminal
   * status alone: it publishes as soon as the last transcript is on the
   * stream, ahead of the blob upload it used to sit behind. True, but it
   * assumed the quiet window below would never need to cover for it — and
   * once that assumption broke (see {@link DEFAULT_DRAIN_QUIET_WINDOW_MS}),
   * 1500ms was also too short to reach the terminal status on a slow
   * finalize. Measured live against this gateway's whisper.cpp finalize path:
   * the tail final lands 3-6s AFTER the server reports `finalizing`, so the
   * old ceiling closed the socket on every call before either the final or
   * the terminal status arrived — reproduced twice; `stopAndDrain(45_000, 0)`
   * was the fix. 45s is sized off the same order of magnitude as the 60s
   * ceiling `PluginManager.destroyInFlight` already assumes a slow drain can
   * need (measured 60.9s in the field) — a generous ceiling for a server that
   * hangs completely, not a tight bound on the happy path.
   */
  static readonly DEFAULT_DRAIN_TIMEOUT_MS = 45_000;
  /**
   * Default silence, in ms, after `finalizing` that ends the drain early —
   * DISABLED by default (`0`, TASK-991; was 250ms).
   *
   * This heuristic resolves as soon as the wire goes quiet, which is exactly
   * what happens while the server is still finalizing: no further partials
   * arrive until the tail final itself does, so silence is not evidence of
   * completion. Measured live against this gateway's whisper.cpp finalize
   * path — the tail final trails `finalizing` by 3-6s — 250ms read that gap
   * as "done" on every call and closed the socket before the final (or the
   * terminal status) ever arrived; a consumer calling `stopAndDrain()` on
   * defaults got partials only, no final. The honest default is to wait for
   * the server's OWN terminal frame rather than guess from silence — a caller
   * that wants the old fast-teardown-at-the-cost-of-the-tail behaviour can
   * still opt back in with an explicit positive `quietWindowMs`.
   */
  static readonly DEFAULT_DRAIN_QUIET_WINDOW_MS = 0;

  private ws: WebSocket | null = null;
  private logger?: ISDKLogger;
  private _debugMode: boolean;
  private debugSegmentCounter = 0;

  private onTranscriptCb?: (result: WsTranscriptResult) => void;
  private onStatusCb?: (status: WsStatusMessage) => void;
  private onWsErrorCb?: (error: WsErrorMessage) => void;
  private onDisconnectCb?: () => void;
  /**
   * Reconnect-lifecycle listeners are MULTI-subscriber, unlike the single-slot
   * callbacks above.
   *
   * Two independent consumers legitimately need the same signal on the same
   * client: `PluginManager` drives the connection-health badge from it, and
   * `StreamingBackendSTTProvider` drives the reconnect ring buffer from it
   * (TASK-985 QW-11). Single-slot registration silently gave the signal to
   * whichever registered LAST and cost the other one its feature.
   */
  private readonly onReconnectCbs: Array<(attempt: number) => void> = [];
  private readonly onReconnectFailedCbs: Array<() => void> = [];
  /** Emitted when a reconnect attempt genuinely re-opens the socket AND the session is resumed. */
  private readonly onReconnectedCbs: Array<() => void> = [];
  /** Emitted whenever a frame is dropped due to backpressure. */
  private onBackpressureDropCb?: (reason: 'queue_full' | 'buffered_amount_high') => void;
  /** Emitted on the server's `ready` frame (TASK-985 M-22). */
  private onReadyCb?: (ready: WsReadyMessage) => void;
  /** Emitted on a server `gap` frame — results the gateway discarded (TASK-985 M-43). */
  private onGapCb?: (gap: WsGapMessage) => void;

  /** Reconnection configuration */
  private reconnectOptions: Required<Omit<WsReconnectOptions, 'refreshTicket'>> & {
    refreshTicket: (() => Promise<string>) | null;
  };
  /** Backpressure configuration. */
  private backpressureOptions: Required<WsBackpressureOptions>;
  /** Number of frames dropped since last connect. */
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
   * Highest transcript `seq` the client has received. Sent
   * as `lastSeq` in the resume handshake on every reconnect.
   */
  private lastReceivedSeq = 0;
  /**
   * Session id captured from the URL on first connect; used as the
   * `sessionId` field in the resume handshake.
   */
  private currentSessionId: string | null = null;
  /**
   * F-31: resolver for an in-flight {@link stopAndDrain} drain window.
   * Set while waiting for the server's terminal status ('closed'/'cancelled')
   * or the drain timeout; `handleMessage` invokes it early on a terminal
   * status so the socket doesn't sit open longer than necessary.
   */
  private pendingDrainResolve: (() => void) | null = null;

  /**
   * The in-flight {@link stopAndDrain} promise, or `null`.
   *
   * SINGLE-FLIGHT: the drain resolver above is a single
   * slot, so a second concurrent `stopAndDrain` used to OVERWRITE the first
   * caller's resolver — the server's terminal status then settled only one of
   * them and the other waited out the full `drainTimeoutMs` ceiling. Concurrent
   * callers now join the same drain.
   */
  private drainInFlight: Promise<void> | null = null;
  /**
   * Progress channel into an in-flight drain. `handleMessage` calls
   * it on every transcript and on a `finalizing` status so the drain can end on
   * a quiet window instead of the full timeout. Null when no drain is pending.
   */
  private pendingDrainNudge: ((event: 'finalizing' | 'transcript') => void) | null = null;
  /** Stop-drain configuration. */
  private drainOptions: Required<WsDrainOptions>;

  // ---------------------------------------------------------------------------
  // Readiness (TASK-985 M-22)
  // ---------------------------------------------------------------------------

  /**
   * Grace period, in ms, after a socket OPENS within which a `ready` frame is
   * expected. When it elapses without one, the client proceeds exactly as it
   * did before `ready` was modelled (resume handshake + reconnect-success on
   * the raw open), so an older gateway keeps working instead of wedging.
   */
  static readonly DEFAULT_READY_GRACE_MS = 1000;

  /** The `ready` frame for the CURRENT connection, or null before it arrives. */
  private ready: WsReadyMessage | null = null;
  /** Resolvers parked by {@link whenReady} while `ready` has not arrived yet. */
  private pendingReadyResolvers: Array<() => void> = [];
  /** Fallback timer that completes the post-open handshake when no `ready` arrives. */
  private readyGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set at open when this open is a RECONNECT, cleared once the post-open
   * handshake has run (from `ready` or from the grace timer, whichever is
   * first) so it can never run twice for one connection.
   */
  private pendingResumeSessionId: string | null = null;

  constructor(
    logger?: ISDKLogger,
    reconnect?: WsReconnectOptions,
    debugMode?: boolean,
    backpressure?: WsBackpressureOptions,
    drain?: WsDrainOptions,
  ) {
    this.logger = logger;
    this._debugMode = debugMode ?? false;
    this.drainOptions = {
      timeoutMs: drain?.timeoutMs ?? SttWebSocketClient.DEFAULT_DRAIN_TIMEOUT_MS,
      quietWindowMs: drain?.quietWindowMs ?? SttWebSocketClient.DEFAULT_DRAIN_QUIET_WINDOW_MS,
    };
    this.reconnectOptions = {
      enabled: reconnect?.enabled ?? false,
      maxAttempts: reconnect?.maxAttempts ?? 5,
      baseDelayMs: reconnect?.baseDelayMs ?? 1000,
      maxDelayMs: reconnect?.maxDelayMs ?? 30_000,
      refreshTicket: reconnect?.refreshTicket ?? null,
      requireTenantClaim: reconnect?.requireTenantClaim ?? true,
    };
    this.backpressureOptions = {
      maxQueueSize: backpressure?.maxQueueSize ?? SttWebSocketClient.DEFAULT_MAX_QUEUE_SIZE,
      bufferedAmountHighWatermark: backpressure?.bufferedAmountHighWatermark ?? SttWebSocketClient.DEFAULT_BUFFERED_AMOUNT_HIGH_WATERMARK,
    };
  }

  /**
   * Connect to the stt WebSocket endpoint.
   * Resolves when connection is open; rejects on failure or timeout.
   *
   * @param url - WebSocket URL
   * @param options - Optional settings (timeoutMs defaults to 10000)
   */
  connect(url: string, options?: WsConnectOptions): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket already connected. Call disconnect() first.'));
    }

    // Fail-closed tenant-claim guard.
    // The guard is now ON BY DEFAULT (`requireTenantClaim` defaults to `true`);
    // callers opt out explicitly with `requireTenantClaim: false`. Reject
    // BEFORE creating a socket when enforcement is active and no claim resolves.
    const requireTenantClaim = options?.requireTenantClaim ?? this.reconnectOptions.requireTenantClaim;
    if (requireTenantClaim && SttWebSocketClient.resolveTenantClaim(url, options) === null) {
      this.logger?.error('WebSocket connect blocked: no tenant claim resolvable from connect context', {
        operation: 'connect',
        component: 'SttWebSocketClient',
        attributes: { url: SttWebSocketClient.stripQueryParams(url) },
      });
      return Promise.reject(new Error('WebSocket connect blocked: no tenant claim resolvable from connect context'));
    }

    const timeoutMs = options?.timeoutMs ?? 10_000;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const safeUrl = SttWebSocketClient.stripQueryParams(url);
      this.logger?.debug('Connecting to stt WebSocket', {
        operation: 'connect',
        component: 'SttWebSocketClient',
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
            component: 'SttWebSocketClient',
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
          this.currentSessionId = SttWebSocketClient.parseSessionId(url) ?? this.currentSessionId;
          this.droppedFrameCount = 0;
          const wasReconnecting = this.isReconnecting;
          if (!this.isReconnecting) {
            this.reconnectAttempts = 0;
          }
          this.intentionalDisconnect = false;
          this.logger?.info('WebSocket connected', {
            operation: 'connect',
            component: 'SttWebSocketClient',
            success: true,
          });
          // TASK-985 M-22 — a new connection has no `ready` yet, whatever the
          // previous one had.
          this.ready = null;
          // The resume handshake and the reconnect-SUCCESS signal used to fire
          // right here, in `onopen`. That raced the gateway: it registers its
          // result-stream handler and only THEN emits `ready`, so a handshake
          // sent on the raw open could ask to replay from `lastSeq` before
          // anything was listening, and the replay was lost. Both now run from
          // the `ready` frame (or, on a gateway that never sends one, from the
          // grace timer below — so this is a reordering, not a new dependency).
          this.pendingResumeSessionId = wasReconnecting ? (this.currentSessionId ?? null) : null;
          this.armReadyGraceTimer();
          resolve();
        }
      };

      ws.onerror = () => {
        this.logger?.error('WebSocket connection error', {
          operation: 'connect',
          component: 'SttWebSocketClient',
        });
      };

      ws.onclose = (event) => {
        cleanup();
        const wasConnected = this.ws !== null;
        this.ws = null;
        // This connection can no longer become ready. Disarm the grace timer so
        // it cannot fire a post-open handshake — and, through it, a
        // reconnect-SUCCESS — against a socket that is already gone.
        this.clearReadyGraceTimer();
        this.pendingResumeSessionId = null;
        this.ready = null;

        this.logger?.debug('WebSocket closed', {
          operation: 'onclose',
          component: 'SttWebSocketClient',
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
   * (zero-copy hot path).
   *
   * Drops the frame and emits a backpressure event when
   * `ws.bufferedAmount` exceeds the configured high-watermark. Returns
   * `false` when the frame was dropped, `true` otherwise.
   */
  // `ArrayBufferView<ArrayBuffer>`, not a bare `ArrayBufferView`: TS 6 makes the view
  // generic over its backing buffer and defaults it to `ArrayBufferLike`, which is NOT
  // a `BufferSource`. The narrowing only makes the signature honest — a
  // SharedArrayBuffer-backed view was never sendable over a WebSocket at runtime.
  sendAudioFrame(data: ArrayBuffer | ArrayBufferView<ArrayBuffer>): boolean {
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
   * Same backpressure policy as `sendAudioFrame`.
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

  /**
   * Declare the metadata in force from HERE ON in this session's audio (TASK-951).
   *
   * The browser-side twin of `RealtimeSttSocket.setMetadata`. Call it whenever what is being
   * captured changes — the live microphone switches, a participant takes over — and every
   * transcript comes back carrying `metadata`, the object in force over ITS OWN audio (sticky:
   * audio sent without a new declaration inherits the last), plus `metadataSpans`, its exact
   * bounds within the segment when a switch fell inside one.
   *
   * No timestamp is sent, and none could be: the client cannot know how much of its audio has
   * been forwarded, and a wall clock would not survive buffering or a reconnect. The gateway
   * places the declaration on its own count of the audio received.
   *
   * NOT subject to the audio backpressure policy: this is a rare control frame, and dropping it
   * would silently mislabel everything that followed. Re-stating the current value is free —
   * the gateway coalesces it.
   *
   * @throws RangeError when the object exceeds 2048 bytes of JSON, at the call site rather than
   * asynchronously as a `METADATA_TOO_LARGE` error frame two utterances later.
   */
  setMetadata(value: Record<string, unknown>): void {
    this.requireConnection();
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytes > MAX_STREAM_METADATA_BYTES) {
      throw new RangeError(`Stream metadata is ${bytes} bytes; the maximum is ${MAX_STREAM_METADATA_BYTES}.`);
    }
    const frame: WsMetadataMessage = { type: 'metadata', metadata: value };
    this.ws!.send(JSON.stringify(frame));
  }

  /** Count of frames dropped due to backpressure since last connect. */
  getDroppedFrameCount(): number {
    return this.droppedFrameCount;
  }

  /**
   * How far behind the room the uplink currently is, in SECONDS of audio
   * (TASK-985 M-36).
   *
   * `bufferedAmount` in bytes is not a quantity anyone can act on; seconds are.
   * This is the number to show beside a degraded-connection badge, and the one
   * that tells a clinician whether to keep talking or wait.
   */
  getBufferedAudioSeconds(): number {
    if (!this.ws) return 0;
    const buffered = (this.ws as { bufferedAmount?: number }).bufferedAmount ?? 0;
    return buffered / SttWebSocketClient.PCM_BYTES_PER_SECOND;
  }

  /** Highest transcript `seq` received from the server. */
  getLastReceivedSeq(): number {
    return this.lastReceivedSeq;
  }

  /** Register a callback invoked when a frame is dropped due to backpressure. */
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
    this.clearReadyGraceTimer();
    this.pendingResumeSessionId = null;
    this.ready = null;
    // Release anyone parked on readiness — this connection is going away, and a
    // waiter that outlives it would otherwise sit out its whole timeout.
    const waiters = this.pendingReadyResolvers;
    this.pendingReadyResolvers = [];
    for (const resolve of waiters) resolve();

    if (this.ws) {
      this.logger?.debug('Disconnecting WebSocket', {
        operation: 'disconnect',
        component: 'SttWebSocketClient',
      });

      const ws = this.ws;
      this.ws = null;
      ws.onclose = null; // prevent re-triggering
      ws.close(1000, 'Client disconnect');

      this.onDisconnectCb?.();
    }
  }

  /**
   * Intentional stop with tail-final drain (F-31).
   *
   * Immediately closing the socket on `stop()` can race a tail final still
   * in flight from the server — the caption is lost from the live UI (the
   * durable transcript is unaffected; the gateway persists it regardless).
   * This sends the `{type:'stop'}` finalize control frame, then keeps the
   * socket OPEN — so any in-flight transcript still reaches the normal
   * {@link onTranscript} callback — until whichever of these comes first:
   *
   * 1. the server's terminal `status` (`closed` or `cancelled`);
   * 2.: a `finalizing` status followed by `quietWindowMs` with no
   *    further transcript (each transcript restarts the window, so a tail
   *    still streaming is never cut off) — OFF by default (TASK-991: see
   *    {@link SttWebSocketClient.DEFAULT_DRAIN_QUIET_WINDOW_MS}), so out of
   *    the box only #1 and #3 apply;
   * 3. `drainTimeoutMs` (default {@link SttWebSocketClient.DEFAULT_DRAIN_TIMEOUT_MS}).
   *
   * Only then does it close.
   *
   * Marks the disconnect intentional up front so the auto-reconnect path in
   * `onclose` never fires for this shutdown, however it is eventually
   * triggered (terminal status, quiet window or timeout).
   *
   * @param drainTimeoutMs - Overrides the configured ceiling for this call.
   * @param quietWindowMs - Overrides the configured quiet window for this call.
   *   `0` disables the early resolve, so the drain ends only on a terminal
   *   status or `drainTimeoutMs`. Pass `undefined` (not `0`) to keep the
   *   configured value — `0` is a meaningful setting here, never "unset".
   */
  stopAndDrain(drainTimeoutMs?: number, quietWindowMs?: number): Promise<void> {
    // Concurrent callers JOIN the in-flight drain (see {@link drainInFlight}) —
    // a second drain window against the same socket cannot end sooner than the
    // first, and starting one used to orphan the first caller's resolver.
    if (this.drainInFlight) {
      this.logger?.info('stopAndDrain: joined in-flight drain', {
        operation: 'stopAndDrain',
        component: 'SttWebSocketClient',
      });
      return this.drainInFlight;
    }
    const run = this.stopAndDrainOnce(drainTimeoutMs, quietWindowMs).finally(() => {
      if (this.drainInFlight === run) this.drainInFlight = null;
    });
    this.drainInFlight = run;
    return run;
  }

  private async stopAndDrainOnce(
    drainTimeoutMs: number = this.drainOptions.timeoutMs,
    quietWindowMsOverride: number = this.drainOptions.quietWindowMs,
  ): Promise<void> {
    // ALWAYS log the effective drain options, including whether each came from
    // the caller or fell back to this client's default. This is the one
    // runtime-observable record of what the drain will actually do — a
    // threading defect anywhere in the option chain (hook → PluginManager →
    // transport → provider → here) is otherwise invisible in a browser: the
    // socket just closes at the default quiet window and the tail final
    // silently never arrives (field defect — a stale @arcaai/stt bundle dropped both values and nothing logged it).
    this.logger?.info('stopAndDrain: effective drain options', {
      operation: 'stopAndDrain',
      component: 'SttWebSocketClient',
      attributes: {
        drainTimeoutMs,
        quietWindowMs: quietWindowMsOverride,
        drainTimeoutIsDefault: drainTimeoutMs === this.drainOptions.timeoutMs,
        quietWindowIsDefault: quietWindowMsOverride === this.drainOptions.quietWindowMs,
        earlyResolveDisabled: quietWindowMsOverride <= 0,
      },
    });
    this.intentionalDisconnect = true;
    this.cancelReconnect();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Nothing to drain — just make sure local state is torn down.
      this.disconnect();
      return;
    }

    try {
      this.ws.send(JSON.stringify({ type: 'stop' }));
    } catch (error) {
      this.logger?.warn('Failed to send stop control frame before drain (best-effort)', {
        operation: 'stopAndDrain',
        component: 'SttWebSocketClient',
        error: error as Error,
      });
    }

    const quietWindowMs = quietWindowMsOverride;

    await new Promise<void>((resolve) => {
      let settled = false;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      let finalizingSeen = false;

      const finish = (reason: 'terminal_status' | 'quiet_window' | 'timeout') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (quietTimer !== null) clearTimeout(quietTimer);
        this.pendingDrainResolve = null;
        this.pendingDrainNudge = null;
        if (reason !== 'terminal_status') {
          this.logger?.debug(`Stop-drain ended on ${reason} without a terminal status`, {
            operation: 'stopAndDrain',
            component: 'SttWebSocketClient',
            attributes: { reason, drainTimeoutMs, quietWindowMs },
          });
        }
        resolve();
      };

      const timer = setTimeout(() => finish('timeout'), drainTimeoutMs);

      const armQuietWindow = () => {
        if (quietWindowMs <= 0) return;
        if (quietTimer !== null) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish('quiet_window'), quietWindowMs);
      };

      this.pendingDrainResolve = () => finish('terminal_status');
      // Only a `finalizing` status opens the quiet window; transcripts merely
      // restart an already-open one. Without that gate, a drain against a
      // server that never acknowledges the stop would close on the first lull
      // in an ordinary utterance stream.
      this.pendingDrainNudge = (event) => {
        if (settled) return;
        if (event === 'finalizing') {
          finalizingSeen = true;
          armQuietWindow();
        } else if (finalizingSeen) {
          armQuietWindow();
        }
      };
    });

    // TASK-985 M-05/M-23 — say goodbye on the APPLICATION protocol, not just the
    // transport.
    //
    // `disconnect()` below only does `ws.close(1000)`. To the gateway that is
    // indistinguishable from a client that fell off the network: it opens its
    // grace window, waits it out, and finalizes the session `interrupted: true`
    // — for a Stop the clinician pressed deliberately. `{type:'close'}` is the
    // frame that says "this was intentional, finalize now", and nothing in the
    // SDK was sending it.
    //
    // Fixed HERE rather than at each call site on purpose: every consumer of
    // `stopAndDrain()` gets it, including the ones that were already draining
    // correctly and the ones that were not.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'close' }));
      } catch (error) {
        this.logger?.warn('Failed to send close control frame after drain (best-effort)', {
          operation: 'stopAndDrain',
          component: 'SttWebSocketClient',
          error: error as Error,
        });
      }
    }

    this.disconnect();
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

  /**
   * Called when a reconnection attempt starts. Provides the attempt number.
   *
   * ADDITIVE, not single-slot (see {@link onReconnectCbs}): every registered
   * listener is called. Returns an unsubscribe function for callers that need
   * to detach; ignoring it is safe and is what every pre-TASK-985 call site does.
   */
  onReconnect(cb: (attempt: number) => void): () => void {
    return SttWebSocketClient.subscribe(this.onReconnectCbs, cb);
  }

  /** Called when all reconnection attempts have been exhausted. Additive; returns an unsubscribe. */
  onReconnectFailed(cb: () => void): () => void {
    return SttWebSocketClient.subscribe(this.onReconnectFailedCbs, cb);
  }

  /**
   * Called when a reconnection attempt has genuinely re-opened the socket AND
   * the session has been resumed on it.
   *
   * Fires on a reconnect only — never on the initial connect — so consumers can
   * transition a 'reconnecting' surface back to live. Contrast `onReconnect`,
   * which fires at attempt-start during backoff.
   *
   * It now fires from the server's `ready` frame rather than from the raw
   * socket open, and strictly AFTER the resume handshake has gone out
   * (TASK-985 M-22). That ordering is what lets a consumer replay buffered
   * audio from this callback and know the handshake precedes it on the wire.
   * On a gateway that sends no `ready`, it fires from the grace timer instead,
   * with the same ordering guarantee.
   *
   * Additive; returns an unsubscribe.
   */
  onReconnected(cb: () => void): () => void {
    return SttWebSocketClient.subscribe(this.onReconnectedCbs, cb);
  }

  /**
   * Called on the server's `ready` frame — the gateway has registered its
   * result-stream handler and the session will now carry results (TASK-985
   * M-22). Single-slot. Prefer {@link whenReady} when you only need to gate
   * your first send.
   */
  onReady(cb: (ready: WsReadyMessage) => void): void {
    this.onReadyCb = cb;
  }

  /**
   * Called when the gateway reports that it DISCARDED results it could not
   * deliver (TASK-985 M-43). The downlink mirror of
   * {@link onBackpressureDrop}: that loses audio on the way up, this loses text
   * on the way down. Single-slot.
   */
  onGap(cb: (gap: WsGapMessage) => void): void {
    this.onGapCb = cb;
  }

  /**
   * Resolve once this connection is READY to carry results.
   *
   * Resolves immediately when `ready` has already arrived, on the frame when it
   * has not, and — deliberately — on `timeoutMs` when it never does. It never
   * REJECTS: a missing readiness signal is a reason to proceed as before, not a
   * reason to fail a consultation. Callers that must know the difference read
   * {@link getReady}.
   */
  whenReady(timeoutMs = SttWebSocketClient.DEFAULT_READY_GRACE_MS): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = this.pendingReadyResolvers.indexOf(done);
        if (index >= 0) this.pendingReadyResolvers.splice(index, 1);
        resolve();
      };
      const timer = setTimeout(() => {
        if (!settled) {
          this.logger?.warn('No `ready` frame within the readiness window — proceeding without the gate', {
            operation: 'whenReady',
            component: 'SttWebSocketClient',
            attributes: { timeoutMs },
          });
        }
        done();
      }, timeoutMs);
      this.pendingReadyResolvers.push(done);
    });
  }

  /** The `ready` frame for the current connection, or `null` if none has arrived. */
  getReady(): WsReadyMessage | null {
    return this.ready;
  }

  /** Add `cb` to `list` and hand back a detach function. Idempotent on detach. */
  private static subscribe<T extends (...args: never[]) => void>(list: T[], cb: T): () => void {
    list.push(cb);
    return () => {
      const index = list.indexOf(cb);
      if (index >= 0) list.splice(index, 1);
    };
  }

  // =========================================================================
  // Reconnection
  // =========================================================================

  /** Get current reconnection attempt count */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * Acknowledge that the connection is stable and end the current reconnect
   * episode, resetting the reconnect counter so future disconnects get a fresh
   * set of attempts. Invoked automatically on the first server message received
   * after a reconnect (`handleMessage`) — the signal that the
   * reconnected session is genuinely alive rather than a brief flap — and also
   * safe to call manually. Idempotent.
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
        component: 'SttWebSocketClient',
        attributes: { maxAttempts: this.reconnectOptions.maxAttempts },
      });
      this.fireReconnectFailed();
      return;
    }

    if (!this.lastUrl) {
      this.isReconnecting = false;
      this.logger?.error('Cannot reconnect — no previous URL stored', {
        operation: 'attemptReconnect',
        component: 'SttWebSocketClient',
      });
      this.fireReconnectFailed();
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const exponentialDelay = Math.min(this.reconnectOptions.baseDelayMs * Math.pow(2, this.reconnectAttempts - 1), this.reconnectOptions.maxDelayMs);
    const jitter = Math.random() * exponentialDelay * 0.5;
    const delay = Math.round(exponentialDelay + jitter);

    this.logger?.debug(`WebSocket reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.reconnectOptions.maxAttempts})`, {
      operation: 'attemptReconnect',
      component: 'SttWebSocketClient',
      attributes: {
        attempt: this.reconnectAttempts,
        maxAttempts: this.reconnectOptions.maxAttempts,
        delayMs: delay,
      },
    });

    for (const cb of [...this.onReconnectCbs]) cb(this.reconnectAttempts);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      if (this.intentionalDisconnect) return;

      let reconnectUrl = this.lastUrl!;
      if (this.reconnectOptions.refreshTicket) {
        try {
          const freshTicket = await this.reconnectOptions.refreshTicket();
          reconnectUrl = SttWebSocketClient.replaceTicketParam(reconnectUrl, freshTicket);
          this.lastUrl = reconnectUrl;
        } catch (err) {
          this.logger?.error('Failed to refresh stream ticket — aborting reconnect (D-18)', {
            operation: 'attemptReconnect',
            component: 'SttWebSocketClient',
            error: err as Error,
            attributes: { attempt: this.reconnectAttempts },
          });
          this.isReconnecting = false;
          this.fireReconnectFailed();
          return;
        }
      }

      this.connect(reconnectUrl, this.lastConnectOptions).catch((error) => {
        this.logger?.warn('WebSocket reconnection attempt failed', {
          operation: 'attemptReconnect',
          component: 'SttWebSocketClient',
          error: error as Error,
          attributes: { attempt: this.reconnectAttempts },
        });
        // A reconnect attempt that fails to OPEN (connection refused, DNS, TLS,
        // or the connect timeout) closes with `this.ws` still null — `onopen`
        // never ran — so `connect`'s `onclose` takes the `!settled` REJECT
        // branch and does NOT re-arm (the `wasConnected` re-arm only fires for a
        // socket that opened and later dropped). Without re-arming here the
        // retry chain died silently before `maxAttempts` and `onReconnectFailed`
        // never fired (F-07). Schedule the next attempt from the failure path;
        // `attemptReconnect` fires `onReconnectFailed` once the budget is spent.
        if (this.reconnectOptions.enabled && !this.intentionalDisconnect) {
          this.attemptReconnect();
        }
      });
    }, delay);
  }

  // =========================================================================
  // Internal
  // =========================================================================

  /** Fire every reconnect-failed listener, over a copy so a detach mid-fire is safe. */
  private fireReconnectFailed(): void {
    this.clearReadyGraceTimer();
    this.pendingResumeSessionId = null;
    for (const cb of [...this.onReconnectFailedCbs]) cb();
  }

  /**
   * Start the fallback window for the server's `ready` frame (TASK-985 M-22).
   *
   * Every open arms it; whichever comes first — the frame or this timer — runs
   * {@link completeOpenHandshake} exactly once for that connection. The timer
   * exists so a gateway that does not send `ready` (or a proxy that swallows
   * it) degrades to the pre-TASK-985 behaviour instead of leaving a reconnected
   * session unresumed.
   */
  private armReadyGraceTimer(): void {
    this.clearReadyGraceTimer();
    this.readyGraceTimer = setTimeout(() => {
      this.readyGraceTimer = null;
      if (this.ready) return;
      this.logger?.warn('Socket opened but no `ready` frame arrived within the grace window', {
        operation: 'armReadyGraceTimer',
        component: 'SttWebSocketClient',
        attributes: { graceMs: SttWebSocketClient.DEFAULT_READY_GRACE_MS, resuming: this.pendingResumeSessionId !== null },
      });
      this.completeOpenHandshake();
    }, SttWebSocketClient.DEFAULT_READY_GRACE_MS);
  }

  private clearReadyGraceTimer(): void {
    if (this.readyGraceTimer !== null) {
      clearTimeout(this.readyGraceTimer);
      this.readyGraceTimer = null;
    }
  }

  /**
   * Run the once-per-connection post-open sequence, in the ONE order that is
   * correct: resume handshake first, reconnect-success second, parked
   * {@link whenReady} waiters last.
   *
   * A consumer replaying buffered audio from `onReconnected` therefore always
   * sends it AFTER the `{type:'resume'}` frame, which is what makes the replay
   * land in the resumed session rather than ahead of it.
   */
  private completeOpenHandshake(): void {
    this.clearReadyGraceTimer();

    // Nothing to hand a listener if the socket went away between the open and
    // this call — a `ready`-less close must not look like a successful resume.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingResumeSessionId = null;
      const orphaned = this.pendingReadyResolvers;
      this.pendingReadyResolvers = [];
      for (const resolve of orphaned) resolve();
      return;
    }

    const resumeSessionId = this.pendingResumeSessionId;
    this.pendingResumeSessionId = null;

    if (resumeSessionId && this.ws) {
      this.sendResumeHandshake(this.ws, resumeSessionId, this.lastReceivedSeq);
    }
    if (resumeSessionId !== null) {
      for (const cb of [...this.onReconnectedCbs]) cb();
    }

    const waiters = this.pendingReadyResolvers;
    this.pendingReadyResolvers = [];
    for (const resolve of waiters) resolve();
  }

  private static stripQueryParams(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      return url.split('?')[0] ?? url;
    }
  }

  /**
   * Resolve the tenant claim for a connection. Prefers
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
   * Tolerant `isFinal` coercion. Accepts a boolean, the
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
    // `text` is the only field a caption cannot survive
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
    const isFinal = SttWebSocketClient.coerceIsFinal(msg.isFinal) ?? SttWebSocketClient.coerceIsFinal(msg.is_final) ?? false;

    const normalized: WsTranscriptResult = {
      type: 'transcript',
      text: msg.text,
      startTime,
      endTime,
      isFinal,
    };

    // Capture server-assigned monotonic sequence number so
    // the client can resume after a reconnect.
    if (typeof msg.seq === 'number' && Number.isFinite(msg.seq)) {
      normalized.seq = msg.seq;
    }

    // Committed-prefix length on partials (dual-cased like
    // the other fields; additive — absent on older servers).
    const rawStableChars =
      typeof msg.stableChars === 'number' ? msg.stableChars : typeof msg.stable_chars === 'number' ? msg.stable_chars : undefined;
    if (typeof rawStableChars === 'number' && Number.isFinite(rawStableChars) && rawStableChars >= 0) {
      normalized.stableChars = Math.floor(rawStableChars);
    }

    // Utterance ordinal (dual-cased, additive).
    const rawUtteranceIndex =
      typeof msg.utteranceIndex === 'number' ? msg.utteranceIndex : typeof msg.utterance_index === 'number' ? msg.utterance_index : undefined;
    if (typeof rawUtteranceIndex === 'number' && Number.isFinite(rawUtteranceIndex) && rawUtteranceIndex >= 0) {
      normalized.utteranceIndex = Math.floor(rawUtteranceIndex);
    }

    // Result kind — the gateway relays it as
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

    // Per-utterance detected language (Sarvam/OpenAI). The gateway relays it as
    // `detectedLanguage`; raw wire payloads may carry `detected_language`/`language`.
    // Additive — absent on engines that don't detect, so it degrades to the
    // session-configured language downstream.
    const detectedLanguage =
      typeof msg.detectedLanguage === 'string'
        ? msg.detectedLanguage
        : typeof msg.detected_language === 'string'
          ? msg.detected_language
          : typeof msg.language === 'string'
            ? msg.language
            : undefined;
    if (detectedLanguage && detectedLanguage.trim().length > 0) {
      normalized.language = detectedLanguage;
    }

    // Per-utterance ASR pipeline provenance. The gateway relays it
    // as `pipelineId`; raw wire payloads may defensively carry `pipeline_id`.
    // Additive — absent on backends that predate per-utterance stamping, so
    // consumers degrade to their request-derived pipeline id.
    const pipelineId = typeof msg.pipelineId === 'string' ? msg.pipelineId : typeof msg.pipeline_id === 'string' ? msg.pipeline_id : undefined;
    if (pipelineId && pipelineId.trim().length > 0) {
      normalized.pipelineId = pipelineId;
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

    // Gateway-owned echo fields (TASK-951). `normalizeTranscript` projects a FIXED field set —
    // anything it does not copy is dropped before a consumer ever sees it — so these three have
    // to be lifted explicitly even though the wire and result types already declare them.
    if (typeof msg.context === 'object' && msg.context !== null && !Array.isArray(msg.context)) {
      normalized.context = msg.context as Record<string, unknown>;
    }
    const sessionEpochMs =
      typeof msg.sessionEpochMs === 'number' ? msg.sessionEpochMs : typeof msg.session_epoch_ms === 'number' ? msg.session_epoch_ms : undefined;
    if (typeof sessionEpochMs === 'number' && Number.isFinite(sessionEpochMs)) {
      normalized.sessionEpochMs = sessionEpochMs;
    }

    // The in-force metadata object (flat, verbatim — the v1 shape) and its time-synced spans.
    // Each span is validated on its own and a malformed one is skipped rather than discarding
    // the caption: a mislabelled span is a labelling loss, a dropped transcript is a clinical
    // one. Anything that yields nothing usable stays ABSENT, never `{}` or `[]`, so "the session
    // sent no metadata" and "this segment had none" read the same way they do on the wire.
    const rawMetadata = (msg as { metadata?: unknown }).metadata;
    if (typeof rawMetadata === 'object' && rawMetadata !== null && !Array.isArray(rawMetadata)) {
      normalized.metadata = rawMetadata as Record<string, unknown>;
    }
    const rawSpans = (msg as { metadataSpans?: unknown }).metadataSpans;
    if (Array.isArray(rawSpans)) {
      const spans = rawSpans
        .filter(
          (span): span is WsMetadataSpan =>
            typeof span === 'object' &&
            span !== null &&
            typeof (span as WsMetadataSpan).from === 'number' &&
            typeof (span as WsMetadataSpan).to === 'number' &&
            typeof (span as WsMetadataSpan).value === 'object' &&
            (span as WsMetadataSpan).value !== null &&
            !Array.isArray((span as WsMetadataSpan).value),
        )
        .map((span) => ({ from: span.from, to: span.to, value: span.value }));
      if (spans.length > 0) {
        normalized.metadataSpans = spans;
      }
    }

    return normalized;
  }

  private static isValidStatus(msg: unknown): msg is WsStatusMessage {
    if (!msg || typeof msg !== 'object') {
      return false;
    }
    // `status` is the only required field. `message` is optional: structured
    // status results (e.g. `provider_switched`) carry typed fields
    // instead of a human message, so requiring `message` here silently dropped
    // the provider-switch notification.
    const candidate = msg as { status?: unknown; message?: unknown };
    return typeof candidate.status === 'string' && (candidate.message === undefined || typeof candidate.message === 'string');
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
        component: 'SttWebSocketClient',
      });
      return;
    }

    try {
      const msg = JSON.parse(event.data) as Record<string, unknown>;

      // The first server message after a reconnect proves the
      // reconnected session is genuinely alive (not a socket that opened and
      // immediately flapped shut). Acknowledge stability here so THIS disconnect
      // episode's attempt budget resets to 0 and the next episode starts with a
      // full budget instead of depleting it cumulatively across the session. A
      // flap that closes before any message arrives never reaches this line, so
      // repeated flapping still exhausts maxAttempts and gives up.
      if (this.isReconnecting) {
        this.acknowledgeConnection();
      }

      switch (msg.type) {
        case 'ready': {
          // TASK-985 M-22 — the gateway's first frame, emitted only after it has
          // registered the result-stream handler. Until now it fell through to
          // `default:` and was logged as an unknown message type, which is why
          // the resume handshake had nothing better than `onopen` to hang off.
          const ready = msg as unknown as WsReadyMessage;
          this.ready = ready;
          this.logger?.debug('Server reported the session ready', {
            operation: 'handleMessage',
            component: 'SttWebSocketClient',
            attributes: { sessionId: ready.sessionId, fromSeq: ready.fromSeq },
          });
          this.onReadyCb?.(ready);
          this.completeOpenHandshake();
          break;
        }
        case 'gap': {
          // TASK-985 M-43 — results the gateway DISCARDED. Also previously an
          // "unknown message type" warning, which meant a clinician could not
          // tell a quiet room from a transcript with a hole in it.
          const gap = msg as unknown as WsGapMessage;
          this.logger?.warn('Server reported a result gap — transcript text was discarded', {
            operation: 'handleMessage',
            component: 'SttWebSocketClient',
            attributes: { reason: gap.reason, droppedPartials: gap.droppedPartials, droppedSeq: gap.droppedSeq },
          });
          this.onGapCb?.(gap);
          break;
        }
        case 'transcript':
          {
            const transcript = SttWebSocketClient.normalizeTranscript(msg);
            if (!transcript) {
              this.logger?.warn('Invalid transcript message — missing required fields', {
                operation: 'handleMessage',
                component: 'SttWebSocketClient',
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
              debugLogTranscript(this.logger, 'SttWebSocket', entry);
            }
            // Track the highest seen seq.
            if (typeof transcript.seq === 'number' && transcript.seq > this.lastReceivedSeq) {
              this.lastReceivedSeq = transcript.seq;
            }
            this.onTranscriptCb?.(transcript);
            // Restart an open drain quiet window — the tail is still arriving.
            this.pendingDrainNudge?.('transcript');
          }
          break;
        case 'resumed': {
          const resumed = msg as unknown as WsResumedMessage;
          this.logger?.info('Server accepted resume handshake', {
            operation: 'handleMessage',
            component: 'SttWebSocketClient',
            attributes: { fromSeq: resumed.fromSeq, sessionId: resumed.sessionId },
          });
          break;
        }
        case 'resume_failed': {
          const failed = msg as unknown as WsResumeFailedMessage;
          this.logger?.warn('Server rejected resume handshake — transcript history lost', {
            operation: 'handleMessage',
            component: 'SttWebSocketClient',
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
          // Distinguish RECOVERABLE from TERMINAL resume failures so the two
          // ends agree (F-06). `buffer_overflow` means the session is ALIVE —
          // only the bounded replay buffer rolled — so the live stream keeps
          // flowing and the client just reconciles against the durable
          // transcript. Any OTHER reason (`unknown_session`, incl. the gateway's
          // "freshly created after grace/cross-instance" rejection) means the
          // session is GONE: the mic is now capturing into a dead session.
          // Surface the terminal reconnect-failed callback so the higher layer
          // tears this session down and establishes a fresh one instead of
          // believing it resumed.
          if (failed.reason !== 'buffer_overflow') {
            this.fireReconnectFailed();
          }
          break;
        }
        case 'status':
          if (!SttWebSocketClient.isValidStatus(msg)) {
            this.logger?.warn('Invalid status message — missing required fields', {
              operation: 'handleMessage',
              component: 'SttWebSocketClient',
              attributes: { keys: Object.keys(msg) },
            });
            return;
          }
          this.onStatusCb?.(msg);
          // F-31: a pending stopAndDrain() resolves as soon as the server
          // confirms the session is genuinely finished, instead of waiting
          // out the full drain timeout.
          if ((msg.status === 'closed' || msg.status === 'cancelled') && this.pendingDrainResolve) {
            this.pendingDrainResolve();
          } else if (msg.status === 'finalizing') {
            // `finalizing` means the server has stopped accepting
            // audio and is emitting whatever tail remains. Open the quiet
            // window so the drain ends on silence rather than the ceiling.
            this.pendingDrainNudge?.('finalizing');
          }
          break;
        case 'error':
          if (!SttWebSocketClient.isValidError(msg)) {
            this.logger?.warn('Invalid error message — missing required fields', {
              operation: 'handleMessage',
              component: 'SttWebSocketClient',
              attributes: { keys: Object.keys(msg) },
            });
            return;
          }
          this.onWsErrorCb?.(msg);
          break;
        default:
          this.logger?.warn('Unknown WebSocket message type', {
            operation: 'handleMessage',
            component: 'SttWebSocketClient',
            attributes: { messageType: String(msg.type ?? 'undefined') },
          });
      }
    } catch (error) {
      this.logger?.error('Failed to parse WebSocket message', {
        operation: 'handleMessage',
        component: 'SttWebSocketClient',
        error: error as Error,
      });
    }
  }

  // =========================================================================
  // Backpressure / resume helpers
  // =========================================================================

  /**
   * Decide whether to drop the next outbound frame because the WS
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
    this.logger?.warn('Dropping audio frame due to backpressure (D-15)', {
      operation: 'sendAudioFrame',
      component: 'SttWebSocketClient',
      attributes: {
        reason,
        bufferedAmount: (this.ws as { bufferedAmount?: number } | null)?.bufferedAmount,
        // The same number in the unit that means something clinically.
        bufferedAudioSeconds: Number(this.getBufferedAudioSeconds().toFixed(2)),
        droppedFrameCount: this.droppedFrameCount,
        highWatermark: this.backpressureOptions.bufferedAmountHighWatermark,
      },
    });
    this.onBackpressureDropCb?.(reason);
  }

  /** Extract `sessionId` query param from a WS URL. */
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
   * freshly-issued value. Used on reconnect. The previous ticket is
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

  /** Send the JSON resume handshake immediately after a reconnect. */
  private sendResumeHandshake(ws: WebSocket, sessionId: string, lastSeq: number): void {
    const handshake: WsResumeRequest = { type: 'resume', sessionId, lastSeq };
    try {
      ws.send(JSON.stringify(handshake));
      this.logger?.debug('Sent resume handshake to server (D-17)', {
        operation: 'sendResumeHandshake',
        component: 'SttWebSocketClient',
        attributes: { sessionId, lastSeq },
      });
    } catch (err) {
      this.logger?.warn('Failed to send resume handshake', {
        operation: 'sendResumeHandshake',
        component: 'SttWebSocketClient',
        error: err as Error,
      });
    }
  }
}
