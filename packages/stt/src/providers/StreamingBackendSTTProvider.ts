/**
 * @arcaai/stt - StreamingBackendSTTProvider
 *
 * Pipeline-aware remote STT provider that replaces the dead-code path
 * through the legacy `RemoteSTTProvider` (`BackendSTTProvider.ts`). This
 * provider does NOT speak the legacy `WebSocketClient` protocol; instead
 * it expects an externally-constructed pair of duck-typed dependencies:
 *
 *   - a `StreamingSessionLike` that owns the REST session lifecycle and
 *     exposes `createSession`, `getWebSocketUrl`, `closeSession`, and the
 *     `refreshTicket` callback used on reconnects.
 *   - a `StreamingWsClientLike` that owns the new STT WebSocket
 *     protocol (`{type:'audio', seq, data}`, ticket-authenticated, with
 *     `lastSeq` resumability).
 *
 * Both interfaces are duck-typed on purpose: the concrete classes live in
 * `@arcaai/vox` (`packages/agentic-sdk-v2`), which already imports
 * `@arcaai/stt`. Adding the reverse dependency would create a cycle. The
 * SDK glue (`packages/agentic-sdk-v2/src/core/PluginManager.ts` +
 * `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts`) is
 * responsible for constructing the concrete instances and injecting them
 * via `STTProcessor.setStreamingTransport(...)`.
 */

import type { TranscriptionResult, STTStats, ProviderConfig, WordTimestamp } from '../types/index.js';
import { BaseSTTProvider } from './BaseSTTProvider.js';
import { float32ToInt16, prepareFloat32ForWhisper } from '../utils/audioResampler.js';

/**
 * Configuration accepted by `StreamingBackendSTTProvider.init`.
 *
 * Extends the base `ProviderConfig` with the mandatory `pipelineId` field
 * that drives backend ASR pipeline orchestration.
 */
export interface StreamingRemoteProviderConfig extends ProviderConfig {
  /** ASR pipeline UUID or slug from the user's tenant. Required. */
  pipelineId: string;
  /** Optional consultation id to link the streaming session to. */
  consultationId?: string;
  /** Optional initial prompt for biasing the transcription. */
  prompt?: string;
  /** Optional microphone identifier surfaced in transcripts. */
  microphoneId?: string;
  /**
   * Ceiling, in ms, on the stop-drain performed by {@link StreamingBackendSTTProvider.destroy}
   *. `destroy()` awaits the drain, so this is the worst-case
   * teardown latency a caller can observe on Stop. Omitted → the ws client's own
   * default (`SttWebSocketClient.DEFAULT_DRAIN_TIMEOUT_MS`, 1500ms).
   *
   * The drain normally ends far sooner: the backend publishes its terminal
   * `closed` status as soon as the last transcript is on the stream, before the
   * recording uploads and durable transcript persistence.
   */
  drainTimeoutMs?: number;
  /**
   * Quiet window, in ms, after the backend's `finalizing` status that ends the
   * stop-drain early. Every transcript received restarts it.
   *
   * **`0` disables the early resolve** — the drain then ends only on the
   * terminal `closed`/`cancelled` status or {@link StreamingRemoteProviderConfig.drainTimeoutMs}.
   * Use it when the tail final matters more than teardown latency: on a slow
   * ASR pipeline the tail can trail `finalizing` by seconds, far past the
   * 250 ms default, and the socket would otherwise already be closed.
   *
   * `0` is therefore GUARDED ON `>= 0`, not `> 0` — unlike `drainTimeoutMs`,
   * where `0` would be meaningless. Omitted / negative ⇒ the ws client's own
   * default.
   */
  quietWindowMs?: number;
  /**
   * Number of distinct microphone SOURCES mixed into this session.
   * A metadata signal for usage repricing, not a PCM channel count (the mix is
   * always mono). Defaults to 1 when omitted.
   */
  channelCount?: number;
}

/**
 * Minimal transcript payload the provider listens for. Mirrors a subset
 * of `WsTranscriptResult` from `@arcaai/vox/types/stt.ts`.
 */
export interface StreamingTranscriptPayload {
  type: 'transcript';
  text: string;
  startTime: number;
  endTime: number;
  isFinal: boolean;
  englishText?: string;
  /** Per-utterance detected language (e.g. `ml-IN`) when the engine reports one. */
  language?: string;
  speakerId?: string;
  speakerLabel?: string;
  speakerConfidence?: number;
  inference?: number;
  seq?: number;
  /**
   * Word-level timestamps from the backend transcript.
   * Mirrors `WsTranscriptResult.wordTimestamps` from `@arcaai/vox`; carried
   * through to {@link TranscriptionResult.words} so the SDK store can expose
   * word timings to consumers.
   */
  wordTimestamps?: WordTimestamp[];
  /**
   * The ASR pipeline that produced THIS utterance. Per-utterance,
   * not per-session: a mid-session engine switch means consecutive transcripts
   * legitimately name different pipelines. Absent from an older backend that
   * does not stamp results.
   */
  pipelineId?: string;
}

/**
 * Duck-typed surface of `@arcaai/vox`'s `SttWebSocketClient` that the
 * provider actually depends on. Keeping this minimal prevents accidental
 * coupling to internal client APIs.
 */
export interface StreamingWsClientLike {
  /**
   * Connect to the WebSocket URL produced by `getWebSocketUrl`. The URL
   * already contains the one-shot stream ticket.
   */
  connect(url: string): Promise<void>;
  /** Reports the most recent connection state. */
  isConnected(): boolean;
  /**
   * Send a binary PCM frame (Int16 LE, mono). Accepts a typed-array view.
   * Returns `false` when the client dropped the frame at its bufferedAmount
   * watermark (backpressure), `true` when it was sent.
   */
  sendAudioFrame(data: ArrayBuffer | ArrayBufferView): boolean;
  /** Tell the server we have finished streaming audio for this turn. */
  sendStop(): void;
  /** Close the WebSocket gracefully. */
  disconnect(): void;
  /**
   * Optional stop-drain: send the stop frame, keep the socket open until the
   * server's terminal status (or the drain timeout) so any tail final still
   * reaches `onTranscript`, then close. Preferred over `disconnect()` on
   * teardown when the client supports it (`SttWebSocketClient` does).
   */
  stopAndDrain?(drainTimeoutMs?: number, quietWindowMs?: number): Promise<void>;
  /** Register the transcript callback. */
  onTranscript(cb: (payload: StreamingTranscriptPayload) => void): void;
  /** Register a server-emitted error callback (e.g. `RESUME_FAILED`). */
  onWsError(cb: (err: { code: string; message: string }) => void): void;
}

/**
 * Duck-typed surface of `@arcaai/vox`'s `StreamingSessionManager`.
 */
export interface StreamingSessionLike {
  createSession(req: {
    pipelineId: string;
    consultationId?: string;
    sampleRate?: number;
    language?: string;
    languageMode?: string;
    /** Pre-start STT engine selection ; default 'primary'.*/
    startOn?: 'primary' | 'fallback';
    microphoneId?: string;
    /** Dual-/multi-mic source count for usage repricing.*/
    channelCount?: number;
  }): Promise<{
    sessionId: string;
    wsUrl: string;
    ticket?: string;
    ticketExpiresAt?: number;
    maxConcurrent: number;
    currentActive: number;
    status: string;
  }>;
  getWebSocketUrl(token?: string): string | null;
  closeSession(): Promise<void>;
  /** Refresh the one-shot stream ticket before reconnect. */
  refreshTicket?(): Promise<string>;
  getSessionId(): string | null;
  /**
   * Request an in-place switch of the live session to the tenant fallback
   * pipeline. Optional: only the vox `StreamingSessionManager`
   * implements it. The backend swaps the ASR engine while the session survives.
   */
  switchToFallback?(): Promise<void>;
}

/**
 * Streaming-aware remote STT provider. Implements the same `STTProvider`
 * interface as `RemoteSTTProvider` so it is a drop-in replacement for
 * `STTProcessor.initializeRemoteProvider`.
 */
export class StreamingBackendSTTProvider extends BaseSTTProvider {
  readonly name = 'streaming-backend';
  readonly type = 'remote' as const;

  private session: StreamingSessionLike;
  private wsClient: StreamingWsClientLike;
  private pipelineId: string | null = null;
  /**
   * Per-session stop-drain ceiling from {@link StreamingRemoteProviderConfig.drainTimeoutMs}.
   * `null` leaves the decision to the ws client's own default.
   */
  private drainTimeoutMs: number | null = null;
  /**
   * Per-session stop-drain quiet window from {@link StreamingRemoteProviderConfig.quietWindowMs}.
   * `null` leaves the decision to the ws client's own default. `0` is a REAL
   * value here (disable the early resolve), which is why the guard below is
   * `>= 0` and why this is `number | null` rather than a falsy-checked number.
   */
  private quietWindowMs: number | null = null;
  /**
   * C6-01 — frames the ws client dropped at its bufferedAmount watermark since
   * the last session start. That PCM never reached the durable transcript, so
   * surfacing the count makes the otherwise-silent loss observable to callers.
   */
  private droppedFrameCount = 0;
  /** Total PCM bytes successfully sent over the wire since the last start — the basis for an uplink-bitrate readout. */
  private bytesSent = 0;
  /**
   * PUSH channel for backpressure drops. `getDroppedFrameCount()` is
   * a passive getter that nothing polls on the SDK path, so the loss dead-ends.
   * This callback fires once per dropped frame (with the running total) so the
   * STT processor / vox pipeline can propagate a degraded signal to the store.
   */
  private onDropCallback: ((droppedFrameCount: number) => void) | null = null;

  constructor(deps: { sessionManager: StreamingSessionLike; wsClient: StreamingWsClientLike }) {
    super();
    this.session = deps.sessionManager;
    this.wsClient = deps.wsClient;

    this.wsClient.onTranscript((payload) => {
      const result = this.normalizeTranscript(payload);
      this.transcriptionCount++;
      this.emitTranscription(result);
    });
    this.wsClient.onWsError((err) => {
      this.emitError(new Error(`[${err.code}] ${err.message}`));
    });
  }

  isSupported(): boolean {
    return typeof WebSocket !== 'undefined';
  }

  async init(config: StreamingRemoteProviderConfig | ProviderConfig): Promise<void> {
    const streamingConfig = config as StreamingRemoteProviderConfig;
    if (!streamingConfig.pipelineId) {
      throw new Error('pipelineId is required for StreamingBackendSTTProvider');
    }

    if (this.initialized) {
      await this.destroy();
    }

    this.config = streamingConfig;
    this.pipelineId = streamingConfig.pipelineId;
    this.drainTimeoutMs =
      typeof streamingConfig.drainTimeoutMs === 'number' && streamingConfig.drainTimeoutMs > 0 ? streamingConfig.drainTimeoutMs : null;
    // `>= 0`, NOT `> 0`: `0` is the documented "disable the quiet-window early
    // resolve" setting. A `> 0` guard here would silently discard exactly the
    // value a caller sets when they need the tail final more than a fast stop.
    this.quietWindowMs =
      typeof streamingConfig.quietWindowMs === 'number' && streamingConfig.quietWindowMs >= 0 ? streamingConfig.quietWindowMs : null;
    this.droppedFrameCount = 0;
    this.bytesSent = 0;

    await this.session.createSession({
      pipelineId: streamingConfig.pipelineId,
      consultationId: streamingConfig.consultationId,
      sampleRate: streamingConfig.sampleRate,
      language: streamingConfig.language,
      // End-user language mode ; the backend resolves it per engine.
      languageMode: streamingConfig.languageMode,
      // Pre-start engine selection ; opens the session on the
      // tenant-admin default provider when 'fallback'.
      startOn: streamingConfig.startOn,
      microphoneId: streamingConfig.microphoneId,
      // Dual-/multi-mic source count for usage repricing.
      channelCount: streamingConfig.channelCount,
    });

    const url = this.session.getWebSocketUrl();
    if (!url) {
      throw new Error('StreamingSessionManager.getWebSocketUrl returned null after createSession');
    }
    await this.wsClient.connect(url);

    this.initialized = true;
  }

  async start(): Promise<void> {
    if (!this.initialized) {
      throw new Error('StreamingBackendSTTProvider.start called before init');
    }
    this.processing = true;
  }

  async stop(): Promise<void> {
    if (!this.processing) {
      return;
    }
    this.processing = false;
    try {
      this.wsClient.sendStop();
    } catch {
      // best-effort; server may already have closed.
    }
  }

  async processAudio(audio: Float32Array, sampleRate: number): Promise<void> {
    if (!this.processing || !this.wsClient.isConnected()) {
      return;
    }
    const resampled = prepareFloat32ForWhisper(audio, sampleRate);
    const int16 = float32ToInt16(resampled);
    this.totalAudioProcessed += resampled.length / 16000;
    // Empty frames (result of resampling very short input) must never reach the wire.
    if (int16.length === 0) {
      return;
    }
    // Forward the view directly; `WebSocket.send` accepts typed arrays
    // natively, so the previous ArrayBuffer.slice copy is gone.
    // Honor the backpressure return: a dropped frame is real audio lost
    // from the durable transcript, so count it instead of silently discarding it.
    const sent = this.wsClient.sendAudioFrame(int16);
    if (sent === false) {
      this.droppedFrameCount++;
      // Push the drop so it reaches the store/hook/UI instead of dead-ending
      // in the unpolled `droppedFrameCount` getter.
      this.onDropCallback?.(this.droppedFrameCount);
    } else {
      // Account only bytes that actually went out (int16 = 2 bytes/sample) so a
      // poller can derive the uplink bitrate.
      this.bytesSent += int16.byteLength;
    }
  }

  async transcribeSegment(_audio: Float32Array): Promise<TranscriptionResult> {
    throw new Error('StreamingBackendSTTProvider does not support direct segment transcription. Use processAudio() for streaming.');
  }

  async destroy(): Promise<void> {
    await this.stop();
    try {
      if (this.wsClient.stopAndDrain) {
        // Drain instead of an immediate close: keeps the socket open until the
        // server's terminal status (or the drain timeout) so a tail final
        // emitted after stop still reaches onTranscript. The duplicate stop
        // frame (stop() above already sent one) is idempotent server-side.
        // `undefined` defers to the client's own default ceiling.
        // `?? undefined` on both, so an unset knob defers to the client's own
        // default. `0` survives it — `??` only replaces null/undefined — which
        // is the whole point of storing the quiet window as `number | null`.
        await this.wsClient.stopAndDrain(this.drainTimeoutMs ?? undefined, this.quietWindowMs ?? undefined);
      } else {
        this.wsClient.disconnect();
      }
    } catch {
      // best-effort; client may already be disconnected.
    }
    // Fire-and-forget on purpose.
    //
    // This DELETE lands on the STT `end_session` route, which calls
    // `_finalize_session` and therefore contends on the SAME per-session
    // finalize lock the first finalize is still holding while it uploads the
    // capture blobs. Awaiting it re-serialized teardown behind MinIO through a
    // second entrypoint — exactly the wait that was moved off the caption path.
    // Once the first finalize completes, the CLOSED short-circuit makes this
    // call an instant no-op, so the await bought nothing but latency.
    //
    // The call itself stays (the backend must still be told), and its failure
    // was ALREADY swallowed, so not awaiting loses no signal. Both a sync throw
    // and a rejected promise are absorbed here so neither can escape as an
    // unhandled rejection.
    try {
      const closing = this.session.closeSession() as unknown;
      if (closing && typeof (closing as PromiseLike<void>).then === 'function') {
        void (closing as Promise<void>).catch(() => {
          // best-effort; backend may have already closed the session.
        });
      }
    } catch {
      // best-effort; backend may have already closed the session.
    }
    this.initialized = false;
    this.pipelineId = null;
    this.drainTimeoutMs = null;
    this.quietWindowMs = null;
  }

  getStats(): STTStats {
    return {
      ...super.getStats(),
      bufferSizeS: 0,
      // Surface the drop count so a poller (STTProcessor.getStats) can read
      // it alongside the push channel below.
      droppedFrames: this.droppedFrameCount,
    };
  }

  /** Visible for diagnostics — which pipeline id we're streaming against. */
  getPipelineId(): string | null {
    return this.pipelineId;
  }

  /**
   * C6-01 — count of frames dropped at the client's bufferedAmount watermark
   * since the last session start. Non-zero means outbound audio was lost from
   * the durable transcript; callers should surface it as a degraded signal.
   */
  getDroppedFrameCount(): number {
    return this.droppedFrameCount;
  }

  /**
   * Total PCM bytes successfully sent over the wire since the last session
   * start. Polled (cumulative, monotonic) — a caller derives an uplink bitrate
   * from the delta between samples; resets to 0 on each `init`.
   */
  getBytesSent(): number {
    return this.bytesSent;
  }

  /**
   * Register a callback fired once per dropped frame (with the running
   * total). This is the PUSH complement to {@link getDroppedFrameCount}:
   * nothing polls the getter on the SDK path, so the count must be pushed up to
   * the store/hook/UI. Single-slot (like `onTranscription`); re-registering
   * replaces the callback.
   */
  onDrop(cb: (droppedFrameCount: number) => void): void {
    this.onDropCallback = cb;
  }

  private normalizeTranscript(payload: StreamingTranscriptPayload): TranscriptionResult {
    const result: TranscriptionResult = {
      text: payload.text,
      isFinal: payload.isFinal,
      // Prefer the ASR engine's per-utterance detected language (Sarvam/OpenAI);
      // fall back to the session-configured language only when none was detected.
      language: payload.language ?? this.config?.language ?? 'en-US',
      duration: Math.max(0, payload.endTime - payload.startTime),
      // Preserve the per-utterance stream-relative offset (seconds) so the SDK
      // hook can stamp `segment.startTime` with a real timeline position instead
      // of falling back to an epoch-ms wall clock. The backend emits
      // these as seconds since stream start; keep them as-is.
      vadStreamStartSec: payload.startTime,
      vadStreamEndSec: payload.endTime,
    };
    if (payload.speakerId) {
      result.speakerId = payload.speakerId;
    }
    if (payload.speakerConfidence !== undefined) {
      result.confidence = payload.speakerConfidence;
    }
    // Preserve word-level timings so they survive into the SDK store
    // (`audio.transcriptSegments[].words`) instead of being dropped.
    if (payload.wordTimestamps && payload.wordTimestamps.length > 0) {
      result.words = payload.wordTimestamps;
    }
    // Per-utterance pipeline provenance. Set only
    // when the backend stamped one, so an older backend leaves the key absent
    // rather than surfacing `undefined` to consumers.
    if (payload.pipelineId) {
      result.pipelineId = payload.pipelineId;
    }
    return result;
  }
}
