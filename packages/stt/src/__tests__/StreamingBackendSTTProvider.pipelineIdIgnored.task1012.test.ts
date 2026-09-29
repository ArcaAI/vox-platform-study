/**
 * TASK-1012 (L-5) — `pipelineId` never reaches the wire.
 *
 * TASK-1006 removed `pipelineId` from every gateway STT route (it answers 400), yet
 * `StreamingBackendSTTProvider` still forwarded a caller-supplied one on session create.
 * 4.0.x keeps the option TYPED (deprecated, removed in 5.0.0) but ignores it: the request
 * carries no `pipelineId` key, and the caller is told once per process.
 *
 * Own file on purpose: the warning is once-per-module, so it needs a fresh module instance.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamingBackendSTTProvider, type StreamingSessionLike, type StreamingWsClientLike } from '../providers/StreamingBackendSTTProvider.js';

function makeWsClient(): StreamingWsClientLike {
  let connected = false;
  return {
    sendAudioFrame: vi.fn(() => true),
    sendStop: vi.fn(),
    sendClose: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn(async () => {
      connected = true;
    }),
    isConnected: vi.fn(() => connected),
    onTranscript: vi.fn(),
    onWsError: vi.fn(),
  };
}

function makeSession(): StreamingSessionLike {
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
    getSessionId: vi.fn(() => 'sess-1'),
  };
}

const baseConfig = {
  sessionId: 'ignored',
  language: 'en-US',
  sampleRate: 16000,
  channels: 1,
  chunkLengthS: 30,
  overlapLengthS: 5,
  returnTimestamps: true,
  codeSwitching: false,
  diarization: false,
  numSpeakers: 2,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StreamingBackendSTTProvider — deprecated pipelineId is ignored (TASK-1012 L-5)', () => {
  it('never sends pipelineId on session create, keeps agentSlug, and warns once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const sessionA = makeSession();
    const providerA = new StreamingBackendSTTProvider({ sessionManager: sessionA, wsClient: makeWsClient() });
    await providerA.init({ ...baseConfig, pipelineId: 'pipeline-doctor-default', agentSlug: 'clinic-asr' });

    const reqA = (sessionA.createSession as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect('pipelineId' in reqA).toBe(false);
    expect(reqA.agentSlug).toBe('clinic-asr');
    expect(providerA.getPipelineId()).toBeNull();

    const sessionB = makeSession();
    const providerB = new StreamingBackendSTTProvider({ sessionManager: sessionB, wsClient: makeWsClient() });
    await providerB.init({ ...baseConfig, pipelineId: 'pipeline-2' });

    const reqB = (sessionB.createSession as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect('pipelineId' in reqB).toBe(false);

    const pipelineWarnings = warn.mock.calls.filter((args) => String(args[0]).includes('pipelineId'));
    expect(pipelineWarnings).toHaveLength(1);
    expect(String(pipelineWarnings[0]![0])).toMatch(/agentSlug/);
  });
});
