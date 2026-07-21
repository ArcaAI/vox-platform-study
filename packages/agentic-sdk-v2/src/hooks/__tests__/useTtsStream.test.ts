/**
 * useTtsStream hook orchestration (WS duplex).
 *
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPlayer, mockStore } = vi.hoisted(() => {
  const mockPlayer = {
    start: vi.fn(async () => undefined),
    enqueuePcm16: vi.fn(),
    end: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
  const mockStore = {
    apiClient: null as {
      post: ReturnType<typeof vi.fn>;
      getWsUrl: () => string | undefined;
      getBaseUrl: () => string;
    } | null,
  };
  return { mockPlayer, mockStore };
});

vi.mock('../../store', () => ({ useAgenticStore: vi.fn(() => mockStore) }));
vi.mock('../../core/TtsPlaybackPlayer', () => ({
  TtsPlaybackPlayer: vi.fn(function () {
    return mockPlayer;
  }),
}));

import { useTtsStream } from '../useTtsStream';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  OPEN = 1;
  CONNECTING = 0;
  url: string;
  binaryType = '';
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
}

async function waitForWs(): Promise<FakeWebSocket> {
  for (let i = 0; i < 50 && FakeWebSocket.instances.length === 0; i++) {
    await Promise.resolve();
  }
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!ws) throw new Error('WebSocket was never constructed');
  return ws;
}

async function openReady(result: { current: ReturnType<typeof useTtsStream> }): Promise<FakeWebSocket> {
  let ws!: FakeWebSocket;
  await act(async () => {
    const p = result.current.open({ voice: 'en-female-1' });
    ws = await waitForWs();
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ type: 'ready', sample_rate: 24000, format: 'pcm', channels: 1 }) });
    await p;
  });
  return ws;
}

describe('useTtsStream (TASK-492)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    mockStore.apiClient = {
      post: vi.fn(async () => ({ ticket: 'tk-1' })),
      getWsUrl: () => undefined,
      getBaseUrl: () => 'http://gw:8868/api/v1',
    };
  });

  it('mints a tts_session ticket and opens the gateway WS at the origin path', async () => {
    const { result } = renderHook(() => useTtsStream());
    const ws = await openReady(result);

    const [endpoint, body] = mockStore.apiClient!.post.mock.calls[0];
    expect(endpoint).toBe('/auth/stream-ticket');
    expect((body as { scope: string }).scope).toMatch(/^tts_session:/);
    // Origin only — the REST `/api/v1` suffix must NOT leak into the WS URL.
    expect(ws.url).toMatch(/^ws:\/\/gw:8868\/ws\/tts-v2\/stream\?sessionId=.+&ticket=tk-1$/);
    expect(ws.binaryType).toBe('arraybuffer');
  });

  it('sends init on open and starts playback + streaming on ready', async () => {
    const { result } = renderHook(() => useTtsStream());
    const ws = await openReady(result);

    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'init', voice: 'en-female-1', format: 'pcm', speed: 1.0 });
    expect(mockPlayer.start).toHaveBeenCalled();
    expect(result.current.isStreaming).toBe(true);
  });

  it('pushText and end forward control frames; binary frames feed the player', async () => {
    const { result } = renderHook(() => useTtsStream());
    const ws = await openReady(result);

    act(() => {
      result.current.pushText('The patient ');
      result.current.end();
    });
    expect(JSON.parse(ws.sent[1])).toEqual({ type: 'text', text: 'The patient ' });
    expect(JSON.parse(ws.sent[2])).toEqual({ type: 'end' });

    act(() => {
      ws.onmessage?.({ data: new Uint8Array([1, 2, 3, 4]).buffer });
    });
    expect(mockPlayer.enqueuePcm16).toHaveBeenCalledTimes(1);

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'done' }) });
    });
    expect(mockPlayer.end).toHaveBeenCalled();
  });

  it('open() throws when the SDK is not initialized', async () => {
    mockStore.apiClient = null;
    const { result } = renderHook(() => useTtsStream());
    await expect(result.current.open({ voice: 'v' })).rejects.toThrow('SDK not initialized');
  });

  it('surfaces a server error and rejects open()', async () => {
    const { result } = renderHook(() => useTtsStream());
    await act(async () => {
      const p = result.current.open({ voice: 'bad' });
      const ws = await waitForWs();
      ws.onopen?.();
      ws.onmessage?.({ data: JSON.stringify({ type: 'error', code: 'invalid_voice', message: 'unknown voice' }) });
      await expect(p).rejects.toThrow('unknown voice');
    });
    expect(result.current.error?.message).toBe('unknown voice');
  });
});
