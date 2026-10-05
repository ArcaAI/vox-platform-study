/**
 * TASK-1042 — `workflowSlug` rides the streaming transport to `createSession` (C1), so a live
 * STT session can be bound to a standalone workflow run instead of a consultation.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { STTProcessor } from '../core/STTProcessor.js';
import type { StreamingSessionLike, StreamingWsClientLike } from '../providers/StreamingBackendSTTProvider.js';

describe('STTProcessor — workflowSlug on the streaming transport (TASK-1042)', () => {
  it('forwards transport.workflowSlug to createSession and sends no consultationId', async () => {
    const processor = new STTProcessor({
      sessionId: 'test-session',
      audio: { language: 'en-US', sampleRate: 16000, channels: 1, chunkLengthS: 30, overlapLengthS: 5 },
      features: { provider: 'remote' },
    });
    const createSession = vi.fn(async () => ({
      sessionId: 'sess-W',
      wsUrl: '/ws/stt/stream',
      maxConcurrent: 8,
      currentActive: 1,
      status: 'active',
    }));
    const session: StreamingSessionLike = {
      createSession,
      getWebSocketUrl: vi.fn(() => 'wss://api.test/ws/stt/stream?sessionId=sess-W'),
      closeSession: vi.fn(async () => {}),
      getSessionId: vi.fn(() => 'sess-W'),
    };
    const wsClient: StreamingWsClientLike = {
      sendAudioFrame: vi.fn(() => true),
      sendStop: vi.fn(),
      sendClose: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(async () => {}),
      isConnected: vi.fn(() => true),
      onTranscript: vi.fn(),
      onWsError: vi.fn(),
    };
    processor.setStreamingTransport({ sessionManager: session, wsClient, workflowSlug: 'live-note' });

    await (processor as unknown as { initializeRemoteProvider(): Promise<void> }).initializeRemoteProvider();

    const req = (createSession.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(req.workflowSlug).toBe('live-note');
    expect(req.consultationId).toBeUndefined();
  });
});
