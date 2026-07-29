/**
 * Live STT session hook. `@arcaai/vox/core` and `@arcaai/stt` are
 * module-mocked (fake WS client + fake capture), fetch is stubbed by pathname,
 * so the state machine is exercised end to end: mic → session create → WS
 * connect (tenant claim in the URL) → frames → transcripts → stop/teardown,
 * plus the designed 429-quota and generic-4401 failure states.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicEnv } from '@/config/public-env';
import { useLiveSttSession } from '../use-live-stt-session';

const { FakeSttWsClient, capture } = vi.hoisted(() => {
  type Handler = (payload?: unknown) => void;

  class FakeSttWsClient {
    static instances: FakeSttWsClient[] = [];
    static ctorArgs: unknown[][] = [];
    connectedUrl: string | null = null;
    connectImpl: () => Promise<void> = async () => {};
    disconnected = false;
    stopSent = false;
    /** When true, sendAudioFrame drops the frame like the real client's watermark. */
    dropFrames = false;
    sentFrames: Array<ArrayBuffer | ArrayBufferView> = [];
    handlers: Record<string, Handler> = {};
    reconnect: { enabled?: boolean; refreshTicket?: () => Promise<string> } | undefined;
    private connected = false;

    constructor(...args: unknown[]) {
      FakeSttWsClient.instances.push(this);
      FakeSttWsClient.ctorArgs.push(args);
      this.reconnect = args[1] as FakeSttWsClient['reconnect'];
    }

    async connect(url: string): Promise<void> {
      this.connectedUrl = url;
      await this.connectImpl();
      this.connected = true;
    }

    disconnect(): void {
      this.disconnected = true;
      this.connected = false;
    }

    isConnected(): boolean {
      return this.connected;
    }

    sendAudioFrame(data: ArrayBuffer | ArrayBufferView): boolean {
      // Mirrors SttWebSocketClient: above the bufferedAmount watermark the
      // frame is dropped and a backpressure event fires.
      if (this.dropFrames) {
        this.handlers.backpressureDrop?.('buffered_amount_high');
        return false;
      }
      this.sentFrames.push(data);
      return true;
    }

    sendStop(): void {
      this.stopSent = true;
    }

    onTranscript(cb: Handler): void {
      this.handlers.transcript = cb;
    }
    onStatus(cb: Handler): void {
      this.handlers.status = cb;
    }
    onWsError(cb: Handler): void {
      this.handlers.wsError = cb;
    }
    onDisconnect(cb: Handler): void {
      this.handlers.disconnect = cb;
    }
    onReconnect(cb: Handler): void {
      this.handlers.reconnect = cb;
    }
    onReconnectFailed(cb: Handler): void {
      this.handlers.reconnectFailed = cb;
    }
    onReconnected(cb: Handler): void {
      this.handlers.reconnected = cb;
    }
    onBackpressureDrop(cb: Handler): void {
      this.handlers.backpressureDrop = cb;
    }
  }

  const capture = {
    onFrame: null as ((frame: Float32Array) => void) | null,
    destroy: vi.fn(),
    setEnabled: vi.fn(),
  };

  return { FakeSttWsClient, capture };
});

vi.mock('@arcaai/vox/core', () => ({ SttWebSocketClient: FakeSttWsClient }));

vi.mock('@arcaai/stt', () => ({
  createAudioCapture: vi.fn(async (_ctx: unknown, _track: unknown, onFrame: (frame: Float32Array) => void) => {
    capture.onFrame = onFrame;
    return { usesWorklet: true, destroy: capture.destroy, setEnabled: capture.setEnabled };
  }),
  float32ToInt16: vi.fn((frame: Float32Array) => new Int16Array(frame.length)),
}));

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(handler: (call: RecordedCall) => Response | undefined): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

const SESSION_RESPONSE = {
  sessionId: 's-9d42',
  status: 'created',
  wsUrl: '/ws/stt/stream',
  maxConcurrent: 5,
  currentActive: 1,
  ticket: 'tkt-abc',
  ticketExpiresAt: 1_900_000_000_000,
  voiceProfileSeeded: true,
};

function sessionHandler(call: RecordedCall): Response | undefined {
  const path = new URL(call.url, 'http://test.local').pathname;
  if (call.method === 'POST' && path === '/api/hope/audio/transcription-jobs/stream/session') {
    return Response.json(SESSION_RESPONSE, { status: 201 });
  }
  if (call.method === 'POST' && path === '/api/hope/audio/transcription-jobs/stream/session/s-9d42/refresh-ticket') {
    return Response.json({ ticket: 'tkt-fresh', ticketExpiresAt: 1_900_000_030_000 });
  }
  if (call.method === 'DELETE' && path === '/api/hope/audio/transcription-jobs/stream/session/s-9d42') {
    return new Response(null, { status: 204 });
  }
  return undefined;
}

const micTrack = { label: 'MacBook Pro Mic', stop: vi.fn() };

beforeEach(() => {
  FakeSttWsClient.instances = [];
  FakeSttWsClient.ctorArgs = [];
  capture.onFrame = null;
  capture.destroy.mockClear();
  micTrack.stop.mockClear();

  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      close = vi.fn(async () => {});
    },
  );
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getAudioTracks: () => [micTrack],
        getTracks: () => [micTrack],
      })),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startedHook() {
  const calls = stubFetch(sessionHandler);
  const hook = renderHook(() => useLiveSttSession());
  await act(async () => {
    await hook.result.current.start({ pipelineId: 'p-1', tenantId: 'tnt-1' });
  });
  return { calls, hook };
}

describe('useLiveSttSession', () => {
  it('start(): mic -> session create -> WS connect on the gateway origin with sessionId, ticket and tenantId', async () => {
    const { calls, hook } = await startedHook();

    // Session created through the BFF with the negotiated sample rate.
    const create = calls.find((call) => call.url.endsWith('/stream/session'));
    expect(create?.body).toEqual({ pipelineId: 'p-1', sampleRate: 16000 });

    // WS client connected directly against the gateway origin.
    const ws = FakeSttWsClient.instances[0];
    const wsOrigin = publicEnv.apiHost.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    expect(ws.connectedUrl).toBe(`${wsOrigin}/ws/stt/stream?sessionId=s-9d42&ticket=tkt-abc&tenantId=tnt-1`);

    expect(hook.result.current.status).toBe('streaming');
    expect(hook.result.current.micPermission).toBe('granted');
    expect(hook.result.current.micLabel).toBe('MacBook Pro Mic');
    expect(hook.result.current.session).toMatchObject({
      sessionId: 's-9d42',
      voiceProfileSeeded: true,
      currentActive: 1,
      maxConcurrent: 5,
      ticketExpiresAt: SESSION_RESPONSE.ticketExpiresAt,
    });

    // Captured frames convert to Int16 PCM and ride the socket.
    act(() => capture.onFrame?.(new Float32Array(1280)));
    expect(ws.sentFrames).toHaveLength(1);
    expect(ws.sentFrames[0]).toBeInstanceOf(Int16Array);

    // Unmount inside the stubbed-fetch window (teardown DELETEs the session).
    hook.unmount();
  });

  it('surfaces the 429 concurrency quota as the designed quota state without opening a socket', async () => {
    stubFetch((call) => {
      const path = new URL(call.url, 'http://test.local').pathname;
      if (call.method === 'POST' && path === '/api/hope/audio/transcription-jobs/stream/session') {
        return Response.json(
          { statusCode: 429, message: 'Tenant is at its concurrent streaming session limit', error: 'Too Many Requests' },
          { status: 429 },
        );
      }
      return undefined;
    });
    const hook = renderHook(() => useLiveSttSession());

    await act(async () => {
      await hook.result.current.start({ pipelineId: 'p-1', tenantId: 'tnt-1' });
    });

    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.quotaExceeded).toBe(true);
    expect(FakeSttWsClient.instances).toHaveLength(0);
    // The mic grabbed for the attempt is released again.
    expect(micTrack.stop).toHaveBeenCalled();
  });

  it('keeps the 4401 handshake failure generic (no cause leak)', async () => {
    stubFetch(sessionHandler);
    const hook = renderHook(() => useLiveSttSession());
    // All handshake failures collapse to a generic 4401 close on the gateway.
    const rejectingConnect = () => Promise.reject(new Error('WebSocket connection failed (code: 4401)'));
    // The instance is created inside start(); pre-seed the next instance's behavior.
    const original = FakeSttWsClient.prototype.connect;
    FakeSttWsClient.prototype.connect = async function (this: InstanceType<typeof FakeSttWsClient>, url: string) {
      this.connectedUrl = url;
      await rejectingConnect();
    };

    await act(async () => {
      await hook.result.current.start({ pipelineId: 'p-1', tenantId: 'tnt-1' });
    });
    FakeSttWsClient.prototype.connect = original;

    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.quotaExceeded).toBe(false);
    expect(hook.result.current.error).toMatch(/expired or unauthorized/i);
    expect(hook.result.current.error).not.toMatch(/4401/);
  });

  it('reduces transcript events into finals plus a single live partial with seq/latency meta', async () => {
    const { hook } = await startedHook();
    const ws = FakeSttWsClient.instances[0];

    act(() =>
      ws.handlers.transcript?.({ type: 'transcript', text: 'worse after', isFinal: false, startTime: 21, endTime: 22, seq: 46, inference: 0.28 }),
    );
    expect(hook.result.current.partial?.text).toBe('worse after');
    expect(hook.result.current.finals).toHaveLength(0);

    act(() =>
      ws.handlers.transcript?.({ type: 'transcript', text: 'worse after long screen time', isFinal: false, startTime: 21, endTime: 23, seq: 46 }),
    );
    // Partials replace in place — never stack.
    expect(hook.result.current.partial?.text).toBe('worse after long screen time');
    expect(hook.result.current.finals).toHaveLength(0);

    act(() =>
      ws.handlers.transcript?.({
        type: 'transcript',
        text: 'Patient reports morning headaches.',
        isFinal: true,
        startTime: 21,
        endTime: 24,
        seq: 47,
        inference: 0.32,
        speakerLabel: 'Doctor',
      }),
    );
    expect(hook.result.current.partial).toBeNull();
    expect(hook.result.current.finals).toHaveLength(1);
    expect(hook.result.current.finals[0]).toMatchObject({ text: 'Patient reports morning headaches.', isFinal: true, speakerLabel: 'Doctor' });
    expect(hook.result.current.lastSeq).toBe(47);
    expect(hook.result.current.lastLatencyMs).toBe(320);

    hook.unmount();
  });

  it('renders the speaker per segment, falling back to speakerId when no friendly label', async () => {
    const { hook } = await startedHook();
    const ws = FakeSttWsClient.instances[0];

    // A canonical label rides the wire → it is preferred verbatim.
    act(() =>
      ws.handlers.transcript?.({
        type: 'transcript',
        text: 'first speaker',
        isFinal: true,
        startTime: 0,
        endTime: 1,
        seq: 1,
        speakerId: 'Speaker 0',
        speakerLabel: 'Speaker 0',
      }),
    );
    // An older worker / bridge sends only the raw id → the hook falls back to it
    // (never drops the attribution). No re-derivation happens in the consumer.
    act(() =>
      ws.handlers.transcript?.({
        type: 'transcript',
        text: 'second speaker',
        isFinal: true,
        startTime: 1,
        endTime: 2,
        seq: 2,
        speakerId: 'Speaker 1',
      }),
    );

    expect(hook.result.current.finals).toHaveLength(2);
    expect(hook.result.current.finals[0]).toMatchObject({ text: 'first speaker', speakerLabel: 'Speaker 0' });
    expect(hook.result.current.finals[1]).toMatchObject({ text: 'second speaker', speakerLabel: 'Speaker 1' });

    hook.unmount();
  });

  it('stop(): sends the stop frame, tears down capture and socket, DELETEs the session', async () => {
    const { calls, hook } = await startedHook();
    const ws = FakeSttWsClient.instances[0];

    await act(async () => {
      await hook.result.current.stop();
    });

    expect(ws.stopSent).toBe(true);
    expect(ws.disconnected).toBe(true);
    expect(capture.destroy).toHaveBeenCalled();
    expect(micTrack.stop).toHaveBeenCalled();
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/stream/session/s-9d42'))).toBe(true);
    expect(hook.result.current.status).toBe('idle');
    // Transcript history survives the stop for review.
    expect(hook.result.current.session).toBeNull();
  });

  it('wires reconnects: refreshTicket mints through the BFF, attempts surface, exhaustion goes generic', async () => {
    const { calls, hook } = await startedHook();
    const ws = FakeSttWsClient.instances[0];

    // The reconnect config handed to the client refreshes via the BFF route.
    const fresh = await ws.reconnect?.refreshTicket?.();
    expect(fresh).toBe('tkt-fresh');
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/stream/session/s-9d42/refresh-ticket'))).toBe(true);

    act(() => ws.handlers.reconnect?.(2));
    expect(hook.result.current.status).toBe('reconnecting');
    expect(hook.result.current.reconnectAttempt).toBe(2);

    await waitFor(() => expect(hook.result.current.session?.ticketExpiresAt).toBe(1_900_000_030_000));

    act(() => ws.handlers.reconnectFailed?.());
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.error).toMatch(/expired or unauthorized/i);

    hook.unmount();
  });

  it('returns to streaming once a reconnect actually re-opens the socket (C6-02)', async () => {
    const { hook } = await startedHook();
    const ws = FakeSttWsClient.instances[0];
    expect(hook.result.current.status).toBe('streaming');

    // Socket drops → the client will attempt to reconnect.
    act(() => ws.handlers.disconnect?.());
    expect(hook.result.current.status).toBe('reconnecting');

    // The client fires onReconnect at attempt-START (during backoff, before
    // the socket is back) — surfacing the attempt number but STILL reconnecting.
    act(() => ws.handlers.reconnect?.(1));
    expect(hook.result.current.status).toBe('reconnecting');
    expect(hook.result.current.reconnectAttempt).toBe(1);

    // The attempt's socket re-opens — the stream is genuinely live again, so
    // the hook must settle back on 'streaming' (previously it stayed stuck).
    act(() => ws.handlers.reconnected?.());
    expect(hook.result.current.status).toBe('streaming');

    hook.unmount();
  });

  it('a late reconnect-success signal never resurrects a stopped session (C6-02 guard)', async () => {
    const { hook } = await startedHook();
    const ws = FakeSttWsClient.instances[0];

    await act(async () => {
      await hook.result.current.stop();
    });
    expect(hook.result.current.status).toBe('idle');

    // A stray reconnect-success arriving after teardown must not flip the
    // idle/stopping surface back to a live 'streaming' (mirrors the
    // onDisconnect statusRef guard).
    act(() => ws.handlers.reconnected?.());
    expect(hook.result.current.status).toBe('idle');
  });

  it('releases the mic and closes the gateway session on terminal reconnect failure (C6-03)', async () => {
    const { calls, hook } = await startedHook();
    const ws = FakeSttWsClient.instances[0];

    // Reconnection is exhausted mid-session. This must mirror the
    // handshake-fail cleanup: no hot mic left on, no held concurrency slot.
    act(() => ws.handlers.reconnectFailed?.());

    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.error).toMatch(/expired or unauthorized/i);
    // Mic track stopped + capture destroyed (releaseAudio ran).
    expect(micTrack.stop).toHaveBeenCalled();
    expect(capture.destroy).toHaveBeenCalled();
    // Gateway streaming session DELETEd — the slot is freed.
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/stream/session/s-9d42'))).toBe(true);
    // Session meta cleared so a fresh start can proceed.
    expect(hook.result.current.session).toBeNull();

    hook.unmount();
  });

  it('latches a session-sticky audio-loss signal that survives reconnect; per-connection count resets (C6-01)', async () => {
    const { hook } = await startedHook();
    const ws = FakeSttWsClient.instances[0];

    // Below the watermark: healthy, nothing latched.
    expect(hook.result.current.audioLostThisSession).toBe(false);
    expect(hook.result.current.droppedFrameCount).toBe(0);

    // Client crosses the 1 MiB bufferedAmount watermark and starts dropping
    // outbound audio — that PCM never reaches the durable transcript.
    ws.dropFrames = true;
    act(() => capture.onFrame?.(new Float32Array(1280)));
    act(() => capture.onFrame?.(new Float32Array(1280)));

    expect(hook.result.current.audioLostThisSession).toBe(true);
    expect(hook.result.current.droppedFrameCount).toBe(2);
    // The dropped frames never rode the socket.
    expect(ws.sentFrames).toHaveLength(0);

    // A reconnect gives a fresh (empty) send buffer, so the per-connection
    // count resets — but a climbing bufferedAmount usually PRECEDES the
    // disconnect, and the transcript is permanently missing those frames, so
    // the sticky loss signal MUST survive the reconnect (patient safety).
    act(() => ws.handlers.reconnect?.(1));
    expect(hook.result.current.droppedFrameCount).toBe(0);
    expect(hook.result.current.audioLostThisSession).toBe(true);

    // Ending the session is the only thing that clears the sticky signal.
    await act(async () => {
      await hook.result.current.stop();
    });
    expect(hook.result.current.audioLostThisSession).toBe(false);
  });
});
