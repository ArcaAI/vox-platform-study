/**
 * TASK-1036 OD-15 / §10.2 — the Test tab's Record control: mic first, then an STT streaming
 * session WITHOUT a consultation (the sandbox run binds it), then the WS with a one-shot ticket,
 * then PCM frames; a live level history drives the waveform; stop drains and closes the session.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wsInstances: FakeSttClient[] = [];
let captureCallback: ((frame: Float32Array) => void) | null = null;
const captureDestroy = vi.fn();

class FakeSttClient {
  connectedUrl: string | null = null;
  sent: unknown[] = [];
  drained = false;
  disconnected = false;
  constructor() {
    wsInstances.push(this);
  }
  async connect(url: string) {
    this.connectedUrl = url;
  }
  disconnect() {
    this.disconnected = true;
  }
  isConnected() {
    return this.connectedUrl !== null && !this.disconnected;
  }
  sendAudioFrame(data: unknown) {
    this.sent.push(data);
    return true;
  }
  sendStop() {}
  async stopAndDrain() {
    this.drained = true;
  }
  onTranscript() {}
  onWsError() {}
  onDisconnect() {}
  onReconnect() {}
  onReconnectFailed() {}
}

vi.mock('@arcaai/vox/core', () => ({ SttWebSocketClient: FakeSttClient }));
vi.mock('@arcaai/stt', () => ({
  createAudioCapture: vi.fn(async (_context: unknown, _track: unknown, onFrame: (frame: Float32Array) => void) => {
    captureCallback = onFrame;
    return { destroy: captureDestroy };
  }),
  float32ToInt16: (frame: Float32Array) => new Int16Array(frame.length),
  createStreamingResampler: () => ({ push: (frame: Float32Array) => frame, flush: () => new Float32Array(0) }),
}));

const { useSandboxRecording } = await import('../use-sandbox-recording');

const trackStop = vi.fn();
let calls: Array<{ method: string; path: string; body?: unknown }> = [];

beforeEach(() => {
  wsInstances.length = 0;
  captureCallback = null;
  calls = [];
  trackStop.mockReset();
  captureDestroy.mockReset();
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 16_000;
      state = 'running';
      async close() {
        this.state = 'closed';
      }
    },
  );
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [{ label: 'Mic', stop: trackStop }], getTracks: () => [{ stop: trackStop }] })) },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test.local');
      calls.push({ method: init?.method ?? 'GET', path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ sessionId: 'stt-1', status: 'active', wsUrl: '/ws/stt/stream', ticket: 'tk-1', ticketExpiresAt: Date.now() + 30_000 }, { status: 201 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSandboxRecording', () => {
  it('opens an STT session without a consultation and streams PCM over a ticketed WS', async () => {
    const { result } = renderHook(() => useSandboxRecording());
    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await result.current.start({ agentSlug: 'asr-ml-en', tenantId: 't-1' });
    });
    expect(sessionId).toBe('stt-1');
    expect(result.current.status).toBe('recording');
    expect(result.current.sessionId).toBe('stt-1');
    expect(calls[0]).toEqual({ method: 'POST', path: '/api/hope/audio/transcription-jobs/stream/session', body: { agentSlug: 'asr-ml-en', sampleRate: 16_000 } });
    const url = new URL(wsInstances[0]!.connectedUrl!);
    expect(url.pathname).toBe('/ws/stt/stream');
    expect(url.searchParams.get('ticket')).toBe('tk-1');
    expect(url.searchParams.get('tenantId')).toBe('t-1');

    act(() => captureCallback?.(new Float32Array([0.5, -0.5, 0.5, -0.5])));
    expect(wsInstances[0]!.sent).toHaveLength(1);
    expect(result.current.levels.length).toBeGreaterThan(0);
  });

  it('stops by draining the socket, closing the session and releasing the mic', async () => {
    const { result } = renderHook(() => useSandboxRecording());
    await act(async () => {
      await result.current.start({ tenantId: 't-1' });
    });
    await act(async () => {
      await result.current.stop();
    });
    expect(wsInstances[0]!.drained).toBe(true);
    expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/api/hope/audio/transcription-jobs/stream/session/stt-1', body: undefined });
    expect(trackStop).toHaveBeenCalled();
    expect(captureDestroy).toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(result.current.sessionId).toBeNull();
  });

  it('reports a refused microphone and never opens a session', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    const { result } = renderHook(() => useSandboxRecording());
    let sessionId: string | null = 'x';
    await act(async () => {
      sessionId = await result.current.start({ tenantId: 't-1' });
    });
    expect(sessionId).toBeNull();
    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/microphone/i);
    expect(calls).toHaveLength(0);
  });
});
