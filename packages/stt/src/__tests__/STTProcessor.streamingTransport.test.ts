/**
 * @arcaai/stt - STTProcessor streaming-transport wiring
 *
 * Verifies that `STTProcessor.initializeRemoteProvider` instantiates the
 * pipeline-aware `StreamingBackendSTTProvider` when a streaming transport
 * has been injected via `setStreamingTransport(...)`, instead of the
 * legacy `RemoteSTTProvider`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STTProcessor } from '../core/STTProcessor.js';
import { StreamingBackendSTTProvider, type StreamingSessionLike, type StreamingWsClientLike } from '../providers/StreamingBackendSTTProvider.js';
import { RemoteSTTProvider } from '../providers/BackendSTTProvider.js';

function makeWsClient(): StreamingWsClientLike & { __isConnected: boolean } {
  const obj = {
    sendAudioFrame: vi.fn(() => true),
    sendStop: vi.fn(),
    sendClose: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn(async () => {
      obj.__isConnected = true;
    }),
    isConnected: vi.fn(() => obj.__isConnected),
    onTranscript: vi.fn(),
    onWsError: vi.fn(),
    __isConnected: false,
  };
  return obj;
}

function makeSession(): StreamingSessionLike {
  return {
    createSession: vi.fn(async () => ({
      sessionId: 'sess-A',
      wsUrl: '/ws/stt/stream',
      ticket: 'T-X',
      maxConcurrent: 8,
      currentActive: 1,
      status: 'active',
    })),
    getWebSocketUrl: vi.fn(() => 'wss://api.test/ws/stt/stream?sessionId=sess-A&ticket=T-X'),
    closeSession: vi.fn(async () => {}),
    refreshTicket: vi.fn(async () => 'T-NEW'),
    getSessionId: vi.fn(() => 'sess-A'),
  };
}

describe('STTProcessor — streaming-transport wiring', () => {
  describe('initializeRemoteProvider', () => {
    let processor: STTProcessor;

    beforeEach(() => {
      processor = new STTProcessor({
        sttSocket: 'wss://legacy/will-be-ignored',
        sessionId: 'test-session',
        audio: { language: 'en-US', sampleRate: 16000, channels: 1, chunkLengthS: 30, overlapLengthS: 5 },
        features: { provider: 'remote' },
      });
    });

    it('uses StreamingBackendSTTProvider when a streaming transport is injected with a pipelineId', async () => {
      const wsClient = makeWsClient();
      const session = makeSession();
      processor.setStreamingTransport({
        sessionManager: session,
        wsClient,
        pipelineId: 'pipeline-test',
      });

      await (processor as unknown as { initializeRemoteProvider(): Promise<void> }).initializeRemoteProvider();

      const provider = processor.getProvider();
      expect(provider).toBeInstanceOf(StreamingBackendSTTProvider);
      expect(session.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ pipelineId: 'pipeline-test' }),
      );
      expect(wsClient.connect).toHaveBeenCalled();
    });

    it('falls back to the legacy RemoteSTTProvider when no streaming transport is set', async () => {
      await (processor as unknown as { initializeRemoteProvider(): Promise<void> }).initializeRemoteProvider();

      const provider = processor.getProvider();
      expect(provider).toBeInstanceOf(RemoteSTTProvider);
      expect(provider).not.toBeInstanceOf(StreamingBackendSTTProvider);
    });

    it('clears the streaming transport via setStreamingTransport(null) and reverts to legacy', async () => {
      const wsClient = makeWsClient();
      const session = makeSession();
      processor.setStreamingTransport({
        sessionManager: session,
        wsClient,
        pipelineId: 'pipeline-1',
      });
      processor.setStreamingTransport(null);

      await (processor as unknown as { initializeRemoteProvider(): Promise<void> }).initializeRemoteProvider();

      const provider = processor.getProvider();
      expect(provider).toBeInstanceOf(RemoteSTTProvider);
      expect(session.createSession).not.toHaveBeenCalled();
    });
  });

  describe('validateConfig', () => {
    it('no longer requires sttSocket when a streaming transport is injected', () => {
      const processor = new STTProcessor({
        sessionId: 'test-session-no-socket',
        audio: { language: 'en-US' },
        features: { provider: 'remote' },
      });
      const wsClient = makeWsClient();
      const session = makeSession();
      processor.setStreamingTransport({
        sessionManager: session,
        wsClient,
        pipelineId: 'pipeline-1',
      });

      expect(() => (processor as unknown as { validateConfig(): void }).validateConfig()).not.toThrow();
    });

    it('still requires sttSocket for legacy callers (no transport set)', () => {
      const processor = new STTProcessor({
        sessionId: 'test-session-no-socket',
        audio: { language: 'en-US' },
        features: { provider: 'remote' },
      });

      expect(() => (processor as unknown as { validateConfig(): void }).validateConfig()).toThrow(
        /sttSocket is required/i,
      );
    });
  });

  // The streaming provider counts backpressure drops, but on the SDK
  // path nothing polls the getter. STTProcessor must (a) re-emit the provider's
  // PUSH channel via `onBackpressureDrop`, and (b) surface the count in getStats()
  // so a consumer (the vox pipeline/store) can render a degraded-connection signal.
  describe('backpressure drop propagation', () => {
    let processor: STTProcessor;
    let wsClient: ReturnType<typeof makeWsClient>;
    let session: StreamingSessionLike;

    beforeEach(async () => {
      processor = new STTProcessor({
        sessionId: 'drop-session',
        audio: { language: 'en-US', sampleRate: 16000, channels: 1, chunkLengthS: 30, overlapLengthS: 5 },
        features: { provider: 'remote' },
      });
      wsClient = makeWsClient();
      session = makeSession();
      processor.setStreamingTransport({ sessionManager: session, wsClient, pipelineId: 'pipeline-drop' });

      await (processor as unknown as { initializeRemoteProvider(): Promise<void> }).initializeRemoteProvider();
      const provider = processor.getProvider() as unknown as { start(): Promise<void> };
      await provider.start();
    });

    it('re-emits provider drops through STTProcessor.onBackpressureDrop', async () => {
      const onDrop = vi.fn();
      processor.onBackpressureDrop(onDrop);

      wsClient.sendAudioFrame.mockReturnValue(false);
      const provider = processor.getProvider() as unknown as {
        processAudio(a: Float32Array, sr: number): Promise<void>;
      };
      await provider.processAudio(new Float32Array([0.1, 0.2]), 16000);
      await provider.processAudio(new Float32Array([0.3, 0.4]), 16000);

      expect(onDrop).toHaveBeenCalledTimes(2);
      expect(onDrop).toHaveBeenLastCalledWith(2);
    });

    it('surfaces the dropped-frame count through getStats().droppedFrames', async () => {
      wsClient.sendAudioFrame.mockReturnValue(false);
      const provider = processor.getProvider() as unknown as {
        processAudio(a: Float32Array, sr: number): Promise<void>;
      };
      await provider.processAudio(new Float32Array([0.1, 0.2]), 16000);

      expect(processor.getStats()?.droppedFrames).toBe(1);
    });
  });
});
