/**
 * @arcaai/stt - StreamingBackendSTTProvider (TASK-298 D-4)
 *
 * Pipeline-aware remote STT provider that replaces the dead-code path
 * through the legacy `RemoteSTTProvider` (`BackendSTTProvider.ts`). This
 * provider does NOT speak the legacy `WebSocketClient` protocol; instead
 * it expects an externally-constructed pair of duck-typed dependencies:
 *
 *   - a `StreamingSessionLike` that owns the REST session lifecycle and
 *     exposes `createSession`, `getWebSocketUrl`, `closeSession`, and the
 *     `refreshTicket` callback used on reconnects (TASK-298 D-18).
 *   - a `StreamingWsClientLike` that owns the new STT-V2 WebSocket
 *     protocol (`{type:'audio', seq, data}`, ticket-authenticated, with
 *     `lastSeq` resumability — TASK-298 D-1 / D-15 / D-17 / D-18).
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
}

/**
 * Minimal transcript payload the provider listens for. Mirrors a subset
 * of `WsTranscriptResult` from `@arcaai/vox/types/stt-v2.ts`.
 */
export interface StreamingTranscriptPayload {
  type: 'transcript';
  text: string;
  startTime: number;
  endTime: number;
  isFinal: boolean;
  englishText?: string;
  speakerId?: string;
  speakerLabel?: string;
  speakerConfidence?: number;
  inference?: number;
  seq?: number;
  /**
   * Word-level timestamps from the backend transcript (TASK-372 D9, Option B).
   * Mirrors `WsTranscriptResult.wordTimestamps` from `@arcaai/vox`; carried
   * through to {@link TranscriptionResult.words} so the SDK store can expose
   * word timings to consumers.
   */
  wordTimestamps?: WordTimestamp[];
}

/**
 * Duck-typed surface of `@arcaai/vox`'s `SttV2WebSocketClient` that the
 * provider actually depends on. Keeping this minimal prevents accidental
 * coupling to internal client APIs.
 */
export interface StreamingWsClientLike {
  /**
   * Connect to the WebSocket URL produced by `getWebSocketUrl`. The URL
   * already contains the one-shot stream ticket (TASK-298 D-1).
   */
  connect(url: string): Promise<void>;
  /** Reports the most recent connection state. */
  isConnected(): boolean;
  /**
   * Send a binary PCM frame (Int16 LE, mono). Accepts a typed-array view.
   * Returns `false` when the client dropped the frame at its bufferedAmount
   * watermark (TASK-298 D-15 backpressure), `true` when it was sent.
   */
  sendAudioFrame(data: ArrayBuffer | ArrayBufferView): boolean;
  /** Tell the server we have finished streaming audio for this turn. */
  sendStop(): void;
  /** Close the WebSocket gracefully. */
  disconnect(): void;
  /** Register the transcript callback. */
  onTranscript(cb: (payload: StreamingTranscriptPayload) => void): void;
  /** Register a server-emitted error callback (e.g. `RESUME_FAILED`). */
  onWsError(cb: (err: { code: string; message: string }) => void): void;
}

/**
 * Duck-typed surface of `@arcaai/vox`'s `StreamingSessionManager`.
 */
export interface StreamingSessionLike {
  createSession(req: { pipelineId: string; consultationId?: string; sampleRate?: number; language?: string; microphoneId?: string }): Promise<{
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
  /** TASK-298 D-18 — refresh the one-shot stream ticket before reconnect. */
  refreshTicket?(): Promise<string>;
  getSessionId(): string | null;
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
   * C6-01 — frames the ws client dropped at its bufferedAmount watermark since
   * the last session start. That PCM never reached the durable transcript, so
   * surfacing the count makes the otherwise-silent loss observable to callers.
   */
  private droppedFrameCount = 0;
  /**
   * TASK-464 — PUSH channel for backpressure drops. `getDroppedFrameCount()` is
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
    this.droppedFrameCount = 0;

    await this.session.createSession({
      pipelineId: streamingConfig.pipelineId,
      consultationId: streamingConfig.consultationId,
      sampleRate: streamingConfig.sampleRate,
      language: streamingConfig.language,
      microphoneId: streamingConfig.microphoneId,
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
    // TASK-351 P0-5 — forward the view directly; `WebSocket.send` accepts
    // typed arrays natively, so the previous ArrayBuffer.slice copy is gone.
    // C6-01 — honor the backpressure return: a dropped frame is real audio lost
    // from the durable transcript, so count it instead of silently discarding it.
    const sent = this.wsClient.sendAudioFrame(int16);
    if (sent === false) {
      this.droppedFrameCount++;
      // TASK-464 — push the drop so it reaches the store/hook/UI instead of
      // dead-ending in the unpolled `droppedFrameCount` getter.
      this.onDropCallback?.(this.droppedFrameCount);
    }
  }

  async transcribeSegment(_audio: Float32Array): Promise<TranscriptionResult> {
    throw new Error('StreamingBackendSTTProvider does not support direct segment transcription. Use processAudio() for streaming.');
  }

  async destroy(): Promise<void> {
    await this.stop();
    try {
      this.wsClient.disconnect();
    } catch {
      // best-effort; client may already be disconnected.
    }
    try {
      await this.session.closeSession();
    } catch {
      // best-effort; backend may have already closed the session.
    }
    this.initialized = false;
    this.pipelineId = null;
  }

  getStats(): STTStats {
    return {
      ...super.getStats(),
      bufferSizeS: 0,
      // TASK-464 — surface the drop count so a poller (STTProcessor.getStats)
      // can read it alongside the push channel below.
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
   * TASK-464 — register a callback fired once per dropped frame (with the
   * running total). This is the PUSH complement to {@link getDroppedFrameCount}:
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
      language: this.config?.language ?? 'en-US',
      duration: Math.max(0, payload.endTime - payload.startTime),
    };
    if (payload.speakerId) {
      result.speakerId = payload.speakerId;
    }
    if (payload.speakerConfidence !== undefined) {
      result.confidence = payload.speakerConfidence;
    }
    // TASK-372 D9 (Option B) — preserve word-level timings so they survive into
    // the SDK store (`audio.transcriptSegments[].words`) instead of being dropped.
    if (payload.wordTimestamps && payload.wordTimestamps.length > 0) {
      result.words = payload.wordTimestamps;
    }
    return result;
  }
}
