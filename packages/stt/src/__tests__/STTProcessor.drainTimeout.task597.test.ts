/**
 * @arcaai/stt — `drainTimeoutMs` reaches the transport (TASK-597 follow-up #4).
 *
 * Lane B2 made the stop-drain ceiling configurable on
 * `StreamingRemoteProviderConfig`, but nothing upstream could set it: the SDK
 * had no way to express a per-capture value. Follow-up #4 threads it
 * `AudioStartOptions.drainTimeoutMs` → `PluginManager` runtime options →
 * `STTStreamingTransport` → here. This file pins the LAST hop — the one where
 * a wrong wiring is invisible until a real Stop takes the wrong amount of time.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STTProcessor } from '../core/STTProcessor.js';
import type { StreamingSessionLike, StreamingWsClientLike } from '../providers/StreamingBackendSTTProvider.js';

function makeWsClient() {
  const obj = {
    sendAudioFrame: vi.fn(() => true),
    sendStop: vi.fn(),
    disconnect: vi.fn(),
    stopAndDrain: vi.fn(async () => {}),
    connect: vi.fn(async () => {
      obj.__isConnected = true;
    }),
    isConnected: vi.fn(() => obj.__isConnected),
    onTranscript: vi.fn(),
    onWsError: vi.fn(),
    __isConnected: false,
  };
  return obj as StreamingWsClientLike & typeof obj;
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

/** Build a processor with an injected transport, run one full init → destroy. */
async function runTeardown(drainTimeoutMs?: number, quietWindowMs?: number) {
  const wsClient = makeWsClient();
  const processor = new STTProcessor({
    sessionId: 'test-session',
    audio: { language: 'en-US', sampleRate: 16000, channels: 1, chunkLengthS: 30, overlapLengthS: 5 },
    features: { provider: 'remote' },
  });
  processor.setStreamingTransport({
    sessionManager: makeSession(),
    wsClient,
    pipelineId: 'pipeline-test',
    ...(drainTimeoutMs !== undefined ? { drainTimeoutMs } : {}),
    ...(quietWindowMs !== undefined ? { quietWindowMs } : {}),
  });

  await (processor as unknown as { initializeRemoteProvider(): Promise<void> }).initializeRemoteProvider();
  await processor.getProvider()?.destroy();
  return wsClient;
}

describe('STTProcessor — drainTimeoutMs threading (TASK-597 follow-up #4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards a transport drainTimeoutMs to the ws client stop-drain', async () => {
    const wsClient = await runTeardown(800);
    expect(wsClient.stopAndDrain).toHaveBeenCalledWith(800, undefined);
  });

  it('passes undefined (⇒ the client default) when the transport carries no value', async () => {
    const wsClient = await runTeardown();
    expect(wsClient.stopAndDrain).toHaveBeenCalledWith(undefined, undefined);
  });

  it.each([0, -5])('IGNORES a non-positive value (%p) — 0 must not mean "do not drain"', async (value) => {
    const wsClient = await runTeardown(value);
    // The provider's own `> 0` guard nulls it, and `?? undefined` hands the ws
    // client its default — losing the tail final would be the alternative.
    expect(wsClient.stopAndDrain).toHaveBeenCalledWith(undefined, undefined);
  });
});

describe('STTProcessor — quietWindowMs threading (TASK-597)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PRESERVES quietWindowMs: 0 — the "wait for the terminal status" setting must survive', async () => {
    // The mirror-image of the `drainTimeoutMs` case above, and the reason the
    // two guards deliberately DIFFER. For a timeout, `0` is meaningless and is
    // dropped. For a quiet window, `0` is the whole point: it disables the
    // early resolve so a tail final that trails `finalizing` by seconds still
    // lands. A copy-pasted `> 0` guard here would silently restore the 250 ms
    // default and close the socket before the transcript arrives.
    const wsClient = await runTeardown(30_000, 0);
    expect(wsClient.stopAndDrain).toHaveBeenCalledWith(30_000, 0);
  });

  it('forwards a positive quietWindowMs', async () => {
    const wsClient = await runTeardown(undefined, 1_500);
    expect(wsClient.stopAndDrain).toHaveBeenCalledWith(undefined, 1_500);
  });

  it('passes undefined (⇒ the client default) when the transport carries no quiet window', async () => {
    const wsClient = await runTeardown(800);
    expect(wsClient.stopAndDrain).toHaveBeenCalledWith(800, undefined);
  });

  it('drops a NEGATIVE quiet window — only 0 is meaningful', async () => {
    const wsClient = await runTeardown(undefined, -1);
    expect(wsClient.stopAndDrain).toHaveBeenCalledWith(undefined, undefined);
  });
});
