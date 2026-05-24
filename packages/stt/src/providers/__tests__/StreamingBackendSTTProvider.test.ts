/**
 * @arcaai/stt - StreamingBackendSTTProvider Tests (TASK-298 D-4)
 *
 * Verifies the new pipeline-aware STT provider that wraps an injected
 * `StreamingSessionManager` + `SttV2WebSocketClient` pair instead of the
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
      wsUrl: '/ws/stt-v2/stream',
      ticket: 'T-abc',
      maxConcurrent: 8,
      currentActive: 1,
      status: 'active',
    })),
    getWebSocketUrl: vi.fn(() => 'wss://api.test/ws/stt-v2/stream?sessionId=sess-1&ticket=T-abc'),
    closeSession: vi.fn(async () => {}),
    refreshTicket: vi.fn(async () => 'T-new'),
    getSessionId: vi.fn(() => 'sess-1'),
    ...overrides,
  };
}

describe('StreamingBackendSTTProvider — TASK-298 D-4', () => {
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
      expect(session.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ pipelineId: 'pipeline-doctor-default' }),
      );
      expect(session.getWebSocketUrl).toHaveBeenCalled();
      expect(wsClient.connect).toHaveBeenCalledWith(
        'wss://api.test/ws/stt-v2/stream?sessionId=sess-1&ticket=T-abc',
      );
      expect(provider.isReady()).toBe(true);
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
      const [buffer] = wsClient.sendAudioFrame.mock.calls[0]!;
      expect(buffer).toBeInstanceOf(ArrayBuffer);
      // Buffer length should be a multiple of 2 bytes per sample.
      expect((buffer as ArrayBuffer).byteLength % 2).toBe(0);
    });

    it('is a no-op when not in the processing state', async () => {
      await provider.stop();
      const samples = new Float32Array([0.1, 0.2]);
      await provider.processAudio(samples, 16000);
      expect(wsClient.sendAudioFrame).not.toHaveBeenCalled();
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
