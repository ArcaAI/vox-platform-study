/**
 * @arcaai/stt - StreamingBackendSTTProvider Tests
 *
 * Verifies the new pipeline-aware STT provider that wraps an injected
 * `StreamingSessionManager` + `SttWebSocketClient` pair instead of the
 * legacy `RemoteSTTProvider` WebSocketClient.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  StreamingBackendSTTProvider,
  type StreamingSessionLike,
  type StreamingWsClientLike,
  type StreamingTranscriptPayload,
} from '../StreamingBackendSTTProvider.js';

function makeWsClient(): StreamingWsClientLike & {
  __emitTranscript: (t: StreamingTranscriptPayload) => void;
  __isConnected: boolean;
} {
  let onTranscriptCb: ((t: StreamingTranscriptPayload) => void) | null = null;
  let onWsErrorCb: ((err: { code: string; message: string }) => void) | null = null;
  const obj = {
    sendAudioFrame: vi.fn(() => true),
    sendStop: vi.fn(),
    sendClose: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn(async () => {
      obj.__isConnected = true;
    }),
    isConnected: vi.fn(() => obj.__isConnected),
    onTranscript: vi.fn((cb: (t: StreamingTranscriptPayload) => void) => {
      onTranscriptCb = cb;
    }),
    onWsError: vi.fn((cb: (err: { code: string; message: string }) => void) => {
      onWsErrorCb = cb;
    }),
    __emitTranscript: (t: StreamingTranscriptPayload) => onTranscriptCb?.(t),
    __emitWsError: (e: { code: string; message: string }) => onWsErrorCb?.(e),
    __isConnected: false,
  };
  return obj;
}

function makeSession(overrides: Partial<StreamingSessionLike> = {}): StreamingSessionLike {
  return {
    createSession: vi.fn(async () => ({
      sessionId: 'sess-1',
      wsUrl: '/ws/stt/stream',
      ticket: 'T-abc',
      maxConcurrent: 8,
      currentActive: 1,
      status: 'active',
    })),
    getWebSocketUrl: vi.fn(() => 'wss://api.test/ws/stt/stream?sessionId=sess-1&ticket=T-abc'),
    closeSession: vi.fn(async () => {}),
    refreshTicket: vi.fn(async () => 'T-new'),
    getSessionId: vi.fn(() => 'sess-1'),
    ...overrides,
  };
}

describe('StreamingBackendSTTProvider', () => {
  let provider: StreamingBackendSTTProvider;
  let wsClient: ReturnType<typeof makeWsClient>;
  let session: StreamingSessionLike;

  beforeEach(() => {
    wsClient = makeWsClient();
    session = makeSession();
    provider = new StreamingBackendSTTProvider({ sessionManager: session, wsClient });
  });

  describe('basic identity', () => {
    it('is registered as a remote provider', () => {
      expect(provider.name).toBe('streaming-backend');
      expect(provider.type).toBe('remote');
    });
  });

  describe('init()', () => {
    it('creates a streaming session with the configured pipelineId and opens the WebSocket', async () => {
      await provider.init({
        sessionId: 'ignored',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: true,
        numSpeakers: 2,
        pipelineId: 'pipeline-doctor-default',
      });

      expect(session.createSession).toHaveBeenCalledTimes(1);
      expect(session.createSession).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'pipeline-doctor-default' }));
      expect(session.getWebSocketUrl).toHaveBeenCalled();
      expect(wsClient.connect).toHaveBeenCalledWith('wss://api.test/ws/stt/stream?sessionId=sess-1&ticket=T-abc');
      expect(provider.isReady()).toBe(true);
    });

    it('forwards the end-user languageMode to createSession (TASK-587)', async () => {
      await provider.init({
        sessionId: 'x',
        language: 'ml',
        languageMode: 'ml-en',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 2,
        pipelineId: 'pipeline-doctor-default',
      });

      expect(session.createSession).toHaveBeenCalledWith(expect.objectContaining({ languageMode: 'ml-en' }));
    });

    it('forwards the pre-start startOn selection to createSession (TASK-586)', async () => {
      await provider.init({
        sessionId: 'x',
        language: 'en',
        startOn: 'fallback',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 2,
        pipelineId: 'pipeline-doctor-default',
      });

      expect(session.createSession).toHaveBeenCalledWith(expect.objectContaining({ startOn: 'fallback' }));
    });

    it('forwards the dual-/multi-mic channelCount to createSession (TASK-615 #12)', async () => {
      await provider.init({
        sessionId: 'x',
        language: 'en',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 2,
        pipelineId: 'pipeline-doctor-default',
        channelCount: 2,
      });

      expect(session.createSession).toHaveBeenCalledWith(expect.objectContaining({ channelCount: 2 }));
    });

    it('throws when pipelineId is missing', async () => {
      await expect(
        provider.init({
          sessionId: 'x',
          language: 'en-US',
          sampleRate: 48000,
          channels: 1,
          chunkLengthS: 30,
          overlapLengthS: 5,
          returnTimestamps: 'word',
          codeSwitching: false,
          diarization: false,
          numSpeakers: 1,
          // @ts-expect-error — intentionally omit pipelineId
          pipelineId: undefined,
        }),
      ).rejects.toThrow(/pipelineId is required/i);
    });
  });

  describe('processAudio()', () => {
    beforeEach(async () => {
      await provider.init({
        sessionId: 'x',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 1,
        pipelineId: 'p-1',
      });
      await provider.start();
    });

    it('resamples to 16 kHz, converts to Int16 LE PCM, and sends a binary frame', async () => {
      const samples = new Float32Array([0.0, 0.5, -0.5, 1.0, -1.0]);
      await provider.processAudio(samples, 48000);

      expect(wsClient.sendAudioFrame).toHaveBeenCalledTimes(1);
      const [frame] = wsClient.sendAudioFrame.mock.calls[0]!;
      // The Int16 view is forwarded directly (no ArrayBuffer.slice copy on
      // the per-frame hot path).
      expect(ArrayBuffer.isView(frame)).toBe(true);
      expect(frame).toBeInstanceOf(Int16Array);
      // Frame length should be a multiple of 2 bytes per sample.
      expect((frame as Int16Array).byteLength % 2).toBe(0);
    });

    it('forwards the Int16 view without slice-copying its buffer', async () => {
      // 16 kHz input → no resampling; conversion yields exactly 4 samples.
      const samples = new Float32Array([0.0, 0.5, -0.5, 1.0]);
      await provider.processAudio(samples, 16000);

      const [frame] = wsClient.sendAudioFrame.mock.calls[0]!;
      const view = frame as Int16Array;
      expect(view).toBeInstanceOf(Int16Array);
      expect(view.length).toBe(4);
      expect(view.byteLength).toBe(8);
      // The view spans its entire backing buffer — no oversized source
      // buffer was retained and no slice copy was made.
      expect(view.byteOffset).toBe(0);
      expect(view.buffer.byteLength).toBe(view.byteLength);
      expect(Array.from(view)).toEqual([0, 16383, -16384, 32767]);
    });

    it('is a no-op when not in the processing state', async () => {
      await provider.stop();
      const samples = new Float32Array([0.1, 0.2]);
      await provider.processAudio(samples, 16000);
      expect(wsClient.sendAudioFrame).not.toHaveBeenCalled();
    });

    it('accumulates sent bytes for the uplink-bitrate poll (TASK-543)', async () => {
      expect(provider.getBytesSent()).toBe(0);
      // 16 kHz input → 4 Int16 samples → 8 bytes.
      await provider.processAudio(new Float32Array([0.0, 0.5, -0.5, 1.0]), 16000);
      expect(provider.getBytesSent()).toBe(8);
      await provider.processAudio(new Float32Array([0.0, 0.5]), 16000);
      expect(provider.getBytesSent()).toBe(12);
    });

    it('does not count bytes for a dropped frame', async () => {
      wsClient.sendAudioFrame.mockReturnValueOnce(false);
      await provider.processAudio(new Float32Array([0.0, 0.5, -0.5, 1.0]), 16000);
      expect(provider.getBytesSent()).toBe(0);
      expect(provider.getDroppedFrameCount()).toBe(1);
    });

    it('skips sending empty frames after resampling (TASK-612 Lane G)', async () => {
      // A very short input (1 sample at 48 kHz) resamples to 0 samples at 16 kHz.
      // Empty frames must never reach the wire.
      const droppedCountBefore = provider.getDroppedFrameCount();
      await provider.processAudio(new Float32Array(1), 48000);

      expect(wsClient.sendAudioFrame).not.toHaveBeenCalled();
      expect(provider.getDroppedFrameCount()).toBe(droppedCountBefore);
      expect(provider.getBytesSent()).toBe(0);
    });
  });

  // C6-01 — the client's bufferedAmount watermark silently drops outbound audio;
  // `sendAudioFrame` returns false on drop. The provider must honor that return so
  // the loss is observable instead of vanishing from the durable transcript.
  describe('backpressure drop visibility (C6-01)', () => {
    beforeEach(async () => {
      await provider.init({
        sessionId: 'x',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 1,
        pipelineId: 'p-1',
      });
      await provider.start();
    });

    it('counts a frame the ws client drops for backpressure (sendAudioFrame returns false)', async () => {
      wsClient.sendAudioFrame.mockReturnValue(false);
      await provider.processAudio(new Float32Array([0.1, 0.2]), 16000);

      expect(wsClient.sendAudioFrame).toHaveBeenCalledTimes(1);
      // The dropped PCM never reached the durable transcript — it is observable.
      expect(provider.getDroppedFrameCount()).toBe(1);
    });

    it('does not count frames while the client accepts them (returns true)', async () => {
      wsClient.sendAudioFrame.mockReturnValue(true);
      await provider.processAudio(new Float32Array([0.1, 0.2]), 16000);
      await provider.processAudio(new Float32Array([0.3, 0.4]), 16000);

      expect(provider.getDroppedFrameCount()).toBe(0);
    });

    // A passive getter is inert (nothing polls it). The provider must
    // PUSH the drop so it can propagate up to the store/hook/UI. `onDrop` fires
    // once per dropped frame with the current cumulative count; `getStats()`
    // surfaces the same count so a poller (STTProcessor.getStats) can read it.
    it('fires the onDrop callback for each dropped frame with the cumulative count', async () => {
      const onDrop = vi.fn();
      provider.onDrop(onDrop);
      wsClient.sendAudioFrame.mockReturnValue(false);

      await provider.processAudio(new Float32Array([0.1, 0.2]), 16000);
      await provider.processAudio(new Float32Array([0.3, 0.4]), 16000);

      expect(onDrop).toHaveBeenCalledTimes(2);
      expect(onDrop).toHaveBeenNthCalledWith(1, 1);
      expect(onDrop).toHaveBeenNthCalledWith(2, 2);
    });

    it('does NOT fire onDrop while the client accepts frames (returns true)', async () => {
      const onDrop = vi.fn();
      provider.onDrop(onDrop);
      wsClient.sendAudioFrame.mockReturnValue(true);

      await provider.processAudio(new Float32Array([0.1, 0.2]), 16000);

      expect(onDrop).not.toHaveBeenCalled();
    });

    it('surfaces droppedFrames in getStats()', async () => {
      wsClient.sendAudioFrame.mockReturnValue(false);
      await provider.processAudio(new Float32Array([0.1, 0.2]), 16000);

      expect(provider.getStats().droppedFrames).toBe(1);
    });
  });

  describe('transcript forwarding', () => {
    beforeEach(async () => {
      await provider.init({
        sessionId: 'x',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 1,
        pipelineId: 'p-1',
      });
      await provider.start();
    });

    it('emits TranscriptionResult to the registered callback', () => {
      const cb = vi.fn();
      provider.onTranscription(cb);

      wsClient.__emitTranscript({
        type: 'transcript',
        text: 'hello world',
        startTime: 0,
        endTime: 1.2,
        isFinal: true,
        speakerId: 'speaker-1',
      });

      expect(cb).toHaveBeenCalledTimes(1);
      const result = cb.mock.calls[0]![0];
      expect(result.text).toBe('hello world');
      expect(result.isFinal).toBe(true);
      expect(result.speakerId).toBe('speaker-1');
    });

    // The engine-detected language (Sarvam/OpenAI) must win over the
    // session-configured language, so metadata reports the REAL language
    // (e.g. Malayalam under an ml-en code-switch mode) not the config echo.
    it('prefers the payload detected language over the configured language', () => {
      const cb = vi.fn();
      provider.onTranscription(cb);

      wsClient.__emitTranscript({
        type: 'transcript',
        text: 'ഒരു',
        startTime: 0,
        endTime: 1,
        isFinal: true,
        language: 'ml-IN',
      });

      expect(cb.mock.calls[0]![0].language).toBe('ml-IN');
    });

    // Absent detection degrades to the configured language (init used 'en-US').
    it('falls back to the configured language when the payload omits one', () => {
      const cb = vi.fn();
      provider.onTranscription(cb);

      wsClient.__emitTranscript({
        type: 'transcript',
        text: 'hello',
        startTime: 0,
        endTime: 1,
        isFinal: true,
      });

      expect(cb.mock.calls[0]![0].language).toBe('en-US');
    });

    // Word-level timestamps must survive normalizeTranscript so the SDK
    // store can expose them to consumers.
    it('carries word-level timestamps through normalizeTranscript into result.words', () => {
      const cb = vi.fn();
      provider.onTranscription(cb);

      const words = [
        { word: 'hello', start: 0.0, end: 0.5, confidence: 0.98 },
        { word: 'world', start: 0.5, end: 1.2, confidence: 0.91 },
      ];
      wsClient.__emitTranscript({
        type: 'transcript',
        text: 'hello world',
        startTime: 0,
        endTime: 1.2,
        isFinal: true,
        wordTimestamps: words,
      });

      expect(cb).toHaveBeenCalledTimes(1);
      const result = cb.mock.calls[0]![0];
      expect(result.words).toEqual(words);
    });

    it('leaves result.words undefined when the payload has no wordTimestamps (back-compat)', () => {
      const cb = vi.fn();
      provider.onTranscription(cb);

      wsClient.__emitTranscript({
        type: 'transcript',
        text: 'no words here',
        startTime: 0,
        endTime: 0.4,
        isFinal: true,
      });

      expect(cb).toHaveBeenCalledTimes(1);
      const result = cb.mock.calls[0]![0];
      expect(result.words).toBeUndefined();
    });

    it('ignores an empty wordTimestamps array (no empty words field)', () => {
      const cb = vi.fn();
      provider.onTranscription(cb);

      wsClient.__emitTranscript({
        type: 'transcript',
        text: 'empty words',
        startTime: 0,
        endTime: 0.4,
        isFinal: true,
        wordTimestamps: [],
      });

      const result = cb.mock.calls[0]![0];
      expect(result.words).toBeUndefined();
    });

    // TASK-591 — the per-utterance stream-relative offset (seconds) MUST reach the
    // SDK as `vadStreamStartSec`/`vadStreamEndSec`, the fields `useArcaAudio` reads
    // to stamp `segment.startTime`. Collapsing them into `duration` only (the old
    // behavior) left those fields undefined on the streaming path, so the hook fell
    // back to `Date.now()` (epoch ms) and the compat playground rendered a garbage
    // `mm:ss` timestamp.
    it('propagates the utterance start/end offset as vadStreamStartSec/vadStreamEndSec', () => {
      const cb = vi.fn();
      provider.onTranscription(cb);

      wsClient.__emitTranscript({
        type: 'transcript',
        text: 'tendency is good',
        startTime: 40.5,
        endTime: 43.25,
        isFinal: true,
      });

      const result = cb.mock.calls[0]![0];
      expect(result.vadStreamStartSec).toBe(40.5);
      expect(result.vadStreamEndSec).toBe(43.25);
      // duration stays derived from the same offsets (unchanged behavior).
      expect(result.duration).toBeCloseTo(2.75, 5);
    });

    it('forwards WS errors to the error callback', () => {
      const errCb = vi.fn();
      provider.onError(errCb);

      wsClient.__emitWsError({ code: 'RESUME_FAILED', message: 'gap too large' });

      expect(errCb).toHaveBeenCalledTimes(1);
      const err = errCb.mock.calls[0]![0];
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toContain('RESUME_FAILED');
    });
  });

  describe('lifecycle', () => {
    it('disconnects the WS and closes the session on destroy()', async () => {
      await provider.init({
        sessionId: 'x',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 1,
        pipelineId: 'p-1',
      });
      await provider.start();
      await provider.destroy();

      expect(wsClient.disconnect).toHaveBeenCalled();
      expect(session.closeSession).toHaveBeenCalled();
      expect(provider.isReady()).toBe(false);
    });

    // TASK-597 lane B — the second serial blocker on click→idle.
    //
    // `closeSession()` DELETEs the backend session, which re-enters
    // `_finalize_session` and therefore contends on the same per-session
    // finalize lock the first finalize still holds while it uploads capture
    // blobs. Awaiting it put those uploads back on the teardown path through a
    // second door. It is best-effort (its failure was already swallowed), so
    // destroy() must issue it and move on.
    it('does not block destroy() on the backend session close', async () => {
      // A close that never settles — the pathological version of "the finalize
      // lock is held". destroy() must not be hostage to it.
      session.closeSession = vi.fn(() => new Promise<void>(() => {}));
      await provider.init({
        sessionId: 'x',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 1,
        pipelineId: 'p-1',
      });
      await provider.start();

      await expect(provider.destroy()).resolves.toBeUndefined();
      // Still ISSUED — the backend must be told; only the wait is gone.
      expect(session.closeSession).toHaveBeenCalledTimes(1);
      expect(provider.isReady()).toBe(false);
    });

    it('swallows a rejected session close instead of failing teardown or leaking an unhandled rejection', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      session.closeSession = vi.fn().mockRejectedValue(new Error('gateway 502'));
      await provider.init({
        sessionId: 'x',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 1,
        pipelineId: 'p-1',
      });
      await provider.start();

      await expect(provider.destroy()).resolves.toBeUndefined();
      // Let any unhandled-rejection detection fire before asserting.
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
      process.off('unhandledRejection', unhandled);
    });

    it('prefers stopAndDrain over disconnect on destroy() when the client supports it', async () => {
      const stopAndDrain = vi.fn().mockResolvedValue(undefined);
      (wsClient as { stopAndDrain?: () => Promise<void> }).stopAndDrain = stopAndDrain;
      await provider.init({
        sessionId: 'x',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 1,
        pipelineId: 'p-1',
      });
      await provider.start();
      await provider.destroy();

      expect(stopAndDrain).toHaveBeenCalled();
      expect(wsClient.disconnect).not.toHaveBeenCalled();
      expect(session.closeSession).toHaveBeenCalled();
      expect(provider.isReady()).toBe(false);
    });

    // TASK-597 lane B2 — `destroy()` awaits the drain, so its ceiling IS the
    // teardown latency a caller observes on Stop. It must be configurable, and
    // must defer to the ws client's own (lower) default when unset.
    it('defers the drain ceiling to the ws client when no drainTimeoutMs is configured', async () => {
      const stopAndDrain = vi.fn().mockResolvedValue(undefined);
      (wsClient as { stopAndDrain?: (ms?: number) => Promise<void> }).stopAndDrain = stopAndDrain;
      await provider.init({
        sessionId: 'x',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 1,
        pipelineId: 'p-1',
      });
      await provider.start();
      await provider.destroy();

      expect(stopAndDrain).toHaveBeenCalledWith(undefined, undefined);
    });

    it('passes a configured drainTimeoutMs through to stopAndDrain', async () => {
      const stopAndDrain = vi.fn().mockResolvedValue(undefined);
      (wsClient as { stopAndDrain?: (ms?: number) => Promise<void> }).stopAndDrain = stopAndDrain;
      await provider.init({
        sessionId: 'x',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 1,
        pipelineId: 'p-1',
        drainTimeoutMs: 800,
      });
      await provider.start();
      await provider.destroy();

      expect(stopAndDrain).toHaveBeenCalledWith(800, undefined);
    });

    it('ignores a non-positive drainTimeoutMs rather than closing the socket instantly', async () => {
      const stopAndDrain = vi.fn().mockResolvedValue(undefined);
      (wsClient as { stopAndDrain?: (ms?: number) => Promise<void> }).stopAndDrain = stopAndDrain;
      await provider.init({
        sessionId: 'x',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 1,
        pipelineId: 'p-1',
        drainTimeoutMs: 0,
      });
      await provider.start();
      await provider.destroy();

      expect(stopAndDrain).toHaveBeenCalledWith(undefined, undefined);
    });

    // TASK-597 — the quiet window is the OTHER half of the drain, and its `0`
    // means something (disable the early resolve) where a `0` timeout does not.
    it('PRESERVES quietWindowMs: 0 through to stopAndDrain', async () => {
      const stopAndDrain = vi.fn().mockResolvedValue(undefined);
      (wsClient as { stopAndDrain?: (ms?: number, q?: number) => Promise<void> }).stopAndDrain = stopAndDrain;
      await provider.init({
        sessionId: 'x',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 1,
        pipelineId: 'p-1',
        drainTimeoutMs: 30000,
        quietWindowMs: 0,
      });
      await provider.start();
      await provider.destroy();

      expect(stopAndDrain).toHaveBeenCalledWith(30000, 0);
    });

    it('ignores a NEGATIVE quietWindowMs — only 0 is meaningful', async () => {
      const stopAndDrain = vi.fn().mockResolvedValue(undefined);
      (wsClient as { stopAndDrain?: (ms?: number, q?: number) => Promise<void> }).stopAndDrain = stopAndDrain;
      await provider.init({
        sessionId: 'x',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 1,
        pipelineId: 'p-1',
        quietWindowMs: -1,
      });
      await provider.start();
      await provider.destroy();

      expect(stopAndDrain).toHaveBeenCalledWith(undefined, undefined);
    });

    it('sends stop and disconnects on stop()', async () => {
      await provider.init({
        sessionId: 'x',
        language: 'en-US',
        sampleRate: 48000,
        channels: 1,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: 'word',
        codeSwitching: false,
        diarization: false,
        numSpeakers: 1,
        pipelineId: 'p-1',
      });
      await provider.start();
      await provider.stop();

      expect(wsClient.sendStop).toHaveBeenCalled();
    });
  });
});
