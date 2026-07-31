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
