/**
 * @arcaai/stt - H-6 WebSocket reconnect backoff + destroyed flag tests (TASK-270)
 *
 * Verifies `WebSocketClient`:
 *   - Uses jittered exponential backoff:
 *       delay = min(cap, base * 2^attempt) * Math.random()
 *   - Aborts pending reconnects after `disconnect()` / `destroy()` via a
 *     `destroyed` flag.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketClient } from '../websocket/WebSocketClient.js';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  static instances: MockWebSocket[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(_data: string | ArrayBuffer | Uint8Array): void {
    /* noop */
  }

  close(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateConnected(sessionId: string): void {
    this.onmessage?.({
      data: JSON.stringify({
        type: 'connected',
        session_id: sessionId,
        audio_config: {},
        timestamp: new Date().toISOString(),
      }),
    });
  }

  simulateClose(code: number, reason: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

async function fullyConnect(client: WebSocketClient, sessionId = 'session-h6'): Promise<MockWebSocket> {
  const promise = client.connect();
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!ws) throw new Error('No WebSocket instance');
  ws.simulateOpen();
  ws.simulateConnected(sessionId);
  await promise;
  return ws;
}

describe('H-6: jittered exponential backoff + destroyed flag', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    MockWebSocket.instances = [];
    // @ts-expect-error - test-only WebSocket mock
    globalThis.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses jittered exponential backoff with Math.random() multiplier', async () => {
    vi.useFakeTimers();
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const client = new WebSocketClient({
      sttSocket: 'wss://example.com/ws',
      sessionId: 'session-h6',
      maxReconnectAttempts: 5,
      reconnectDelay: 1000,
      connectionTimeout: 5000,
    });

    const ws1 = await fullyConnect(client);
    // First abnormal close — schedules reconnect attempt #1
    ws1.simulateClose(1006, 'lost');

    // attempt 1: base * 2^0 = 1000, jitter 0.5 -> 500ms
    await vi.advanceTimersByTimeAsync(400);
    expect(MockWebSocket.instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(MockWebSocket.instances.length).toBe(2);

    // Second abnormal close on the reconnect socket
    const ws2 = MockWebSocket.instances[1]!;
    ws2.simulateClose(1006, 'lost again');

    // attempt 2: base * 2^1 = 2000, jitter 0.5 -> 1000ms
    await vi.advanceTimersByTimeAsync(900);
    expect(MockWebSocket.instances.length).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(MockWebSocket.instances.length).toBe(3);

    // Third attempt: base * 2^2 = 4000, jitter 0.5 -> 2000ms
    const ws3 = MockWebSocket.instances[2]!;
    ws3.simulateClose(1006, 'still down');
    await vi.advanceTimersByTimeAsync(1800);
    expect(MockWebSocket.instances.length).toBe(3);
    await vi.advanceTimersByTimeAsync(300);
    expect(MockWebSocket.instances.length).toBe(4);

    randSpy.mockRestore();
  });

  it('caps the backoff at 30s', async () => {
    vi.useFakeTimers();
    // Random = 1 so jitter is at its maximum multiplier and the cap is the
    // active constraint.
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(1);

    const client = new WebSocketClient({
      sttSocket: 'wss://example.com/ws',
      sessionId: 'session-h6-cap',
      maxReconnectAttempts: 20,
      reconnectDelay: 1000,
      connectionTimeout: 5000,
    });

    const ws = await fullyConnect(client, 'session-h6-cap');

    // Burn through several reconnect cycles to push the exponential delay
    // beyond 30 s, then verify reconnect still fires within 30 s.
    let currentWs = ws;
    for (let i = 0; i < 6; i++) {
      currentWs.simulateClose(1006, 'down');
      // Cap is 30s. Even if exp delay would be larger, advancing past 30s
      // should fire the reconnect.
      await vi.advanceTimersByTimeAsync(30_001);
      const next = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
      expect(next).not.toBe(currentWs);
      currentWs = next;
    }

    randSpy.mockRestore();
  });

  it('aborts a scheduled reconnect when destroy() is called', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const client = new WebSocketClient({
      sttSocket: 'wss://example.com/ws',
      sessionId: 'session-h6-destroy',
      maxReconnectAttempts: 5,
      reconnectDelay: 1000,
      connectionTimeout: 5000,
    });

    const ws = await fullyConnect(client, 'session-h6-destroy');
    expect(MockWebSocket.instances.length).toBe(1);

    ws.simulateClose(1006, 'gone');

    // Reconnect is now scheduled. Call destroy() before the timer fires.
    expect(client.destroy).toBeTypeOf('function');
    client.destroy();

    await vi.advanceTimersByTimeAsync(60_000);

    // No reconnect WebSocket created
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it('aborts a scheduled reconnect when disconnect() is called mid-reconnect', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const client = new WebSocketClient({
      sttSocket: 'wss://example.com/ws',
      sessionId: 'session-h6-disc',
      maxReconnectAttempts: 5,
      reconnectDelay: 1000,
      connectionTimeout: 5000,
    });

    const ws = await fullyConnect(client, 'session-h6-disc');
    ws.simulateClose(1006, 'gone');

    // Reconnect scheduled; calling disconnect() must clear it so no further
    // connect attempts run.
    client.disconnect();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(MockWebSocket.instances.length).toBe(1);
  });

  it('destroy() prevents subsequent connect() calls', async () => {
    const client = new WebSocketClient({
      sttSocket: 'wss://example.com/ws',
      sessionId: 'session-h6-destroyed-connect',
      connectionTimeout: 5000,
    });

    client.destroy();

    await expect(client.connect()).rejects.toThrow(/destroyed/i);
    expect(MockWebSocket.instances.length).toBe(0);
  });
});
