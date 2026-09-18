/**
 * TASK-985 — the four transport defects this client carried.
 *
 * 1. M-05 / M-23: `stopAndDrain()` sent `{type:'stop'}`, waited for the tail and
 *    then did a raw `ws.close(1000)`. To the gateway that is indistinguishable
 *    from a client that fell off the network: it opens its grace window, waits
 *    it out, and files a deliberate Stop as `interrupted`. The application-level
 *    `{type:'close'}` frame — the one that says "this was intentional" — was
 *    never sent by anything in the SDK.
 * 2. M-22: `ready` fell into the `default:` "unknown message type" branch, so
 *    the resume handshake had nothing better to hang off than the raw socket
 *    open — which happens BEFORE the gateway registers its result-stream
 *    handler, so a replay could be asked for with nothing listening.
 * 3. M-43: `gap` fell into the same branch, so a clinician could not tell a
 *    quiet room from a transcript with text missing out of the middle of it.
 * 4. QW-11 prerequisite: the reconnect callbacks were single-slot, so
 *    `PluginManager` (connection-health badge) and the STT provider (ring
 *    buffer) could not both listen — the later registration silently won.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SttWebSocketClient } from '../SttWebSocketClient';
import { createMockLogger } from '../../__tests__/setup';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  binaryType: BinaryType = 'blob';
  bufferedAmount = 0;
  sent: Array<string | ArrayBufferLike> = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string | ArrayBufferLike): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code: code ?? 1000, reason: reason ?? '' }));
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** Control frames only, parsed, in send order. */
  controlFrames(): Array<Record<string, unknown>> {
    return this.sent.filter((frame): frame is string => typeof frame === 'string').map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
}

const originalWebSocket = globalThis.WebSocket;
let lastMockWs: MockWebSocket | null = null;

beforeEach(() => {
  lastMockWs = null;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      lastMockWs = this;
    }
  };
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  lastMockWs = null;
  vi.clearAllMocks();
});

async function connected(client: SttWebSocketClient, url = 'wss://example.com/ws?sessionId=s-1&tenantId=t-1'): Promise<MockWebSocket> {
  const connecting = client.connect(url);
  lastMockWs!.simulateOpen();
  await connecting;
  return lastMockWs!;
}

describe('stopAndDrain sends the application-level close frame (TASK-985 M-05/M-23)', () => {
  it('sends {type:"close"} after the tail, immediately before the transport close', async () => {
    const client = new SttWebSocketClient(createMockLogger());
    const ws = await connected(client);

    const drain = client.stopAndDrain();
    ws.simulateMessage(JSON.stringify({ type: 'status', status: 'closed' }));
    await drain;

    const types = ws.controlFrames().map((frame) => frame.type);
    expect(types).toEqual(['stop', 'close']);
    expect(client.isConnected()).toBe(false);
  });

  it('does not send it when the socket was never open — there is nobody to tell', async () => {
    const client = new SttWebSocketClient(createMockLogger());
    await expect(client.stopAndDrain()).resolves.toBeUndefined();
    expect(lastMockWs).toBeNull();
  });

  it('closes anyway when the close frame throws — teardown must not depend on the socket being cooperative', async () => {
    const client = new SttWebSocketClient(createMockLogger());
    const ws = await connected(client);

    const drain = client.stopAndDrain();
    ws.simulateMessage(JSON.stringify({ type: 'status', status: 'closed' }));
    // Only the CLOSE send fails (the stop frame already went out).
    ws.send = () => {
      throw new Error('socket is gone');
    };
    await expect(drain).resolves.toBeUndefined();
    expect(client.isConnected()).toBe(false);
  });
});

describe('the `ready` frame (TASK-985 M-22)', () => {
  it('reaches onReady instead of the "unknown message type" branch', async () => {
    const logger = createMockLogger();
    const client = new SttWebSocketClient(logger);
    const ws = await connected(client);

    const onReady = vi.fn();
    client.onReady(onReady);
    ws.simulateMessage(JSON.stringify({ type: 'ready', sessionId: 's-1', fromSeq: 4, sessionEpochMs: 1_700_000_000_000 }));

    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready', sessionId: 's-1', fromSeq: 4 }));
    expect(logger.warn).not.toHaveBeenCalledWith('Unknown WebSocket message type', expect.anything());
    expect(client.getReady()).toMatchObject({ fromSeq: 4, sessionEpochMs: 1_700_000_000_000 });
  });

  it('whenReady() resolves on the frame, and resolves immediately once it has already arrived', async () => {
    const client = new SttWebSocketClient(createMockLogger());
    const ws = await connected(client);

    let settled = false;
    const waiting = client.whenReady(60_000).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    ws.simulateMessage(JSON.stringify({ type: 'ready', sessionId: 's-1' }));
    await waiting;
    expect(settled).toBe(true);

    await expect(client.whenReady(60_000)).resolves.toBeUndefined();
  });

  it('whenReady() RESOLVES on timeout rather than rejecting — a missing signal is not a reason to fail a consultation', async () => {
    vi.useFakeTimers();
    try {
      const client = new SttWebSocketClient(createMockLogger());
      await connected(client);

      const waiting = client.whenReady(50);
      await vi.advanceTimersByTimeAsync(51);
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases whenReady() waiters on disconnect instead of stranding them for the full timeout', async () => {
    const client = new SttWebSocketClient(createMockLogger());
    await connected(client);

    const waiting = client.whenReady(60_000);
    client.disconnect();

    await expect(waiting).resolves.toBeUndefined();
  });
});

describe('the `gap` frame (TASK-985 M-43)', () => {
  it('reaches onGap, carrying the reason and what was lost', async () => {
    const logger = createMockLogger();
    const client = new SttWebSocketClient(logger);
    const ws = await connected(client);

    const onGap = vi.fn();
    const onWsError = vi.fn();
    client.onGap(onGap);
    client.onWsError(onWsError);

    ws.simulateMessage(JSON.stringify({ type: 'gap', reason: 'egress_partial_dropped', sessionId: 's-1', droppedPartials: 7 }));

    expect(onGap).toHaveBeenCalledWith(expect.objectContaining({ reason: 'egress_partial_dropped', droppedPartials: 7 }));
    // It is a settled outcome, not a retryable failure: routing it to the error
    // channel would invite a consumer to reconnect for text that is gone.
    expect(onWsError).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith('Unknown WebSocket message type', expect.anything());
  });
});

describe('reconnect listeners are additive (TASK-985 QW-11 prerequisite)', () => {
  it('delivers to EVERY registrant — the health badge and the ring buffer both need this signal', async () => {
    vi.useFakeTimers();
    const mathRandom = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const client = new SttWebSocketClient(createMockLogger(), { enabled: true, maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5_000 });
      const first = vi.fn();
      const second = vi.fn();
      client.onReconnect(first);
      client.onReconnect(second);

      const connecting = client.connect('wss://example.com/ws?sessionId=s-1&tenantId=t-1');
      lastMockWs!.simulateOpen();
      await connecting;

      lastMockWs!.close(1006, 'lost');
      await vi.advanceTimersByTimeAsync(101);

      expect(first).toHaveBeenCalledWith(1);
      expect(second).toHaveBeenCalledWith(1);
    } finally {
      mathRandom.mockRestore();
      vi.useRealTimers();
    }
  });

  it('returns an unsubscribe that detaches only that listener', async () => {
    vi.useFakeTimers();
    const mathRandom = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const client = new SttWebSocketClient(createMockLogger(), { enabled: true, maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5_000 });
      const kept = vi.fn();
      const detached = vi.fn();
      client.onReconnect(kept);
      const unsubscribe = client.onReconnect(detached);
      unsubscribe();

      const connecting = client.connect('wss://example.com/ws?sessionId=s-1&tenantId=t-1');
      lastMockWs!.simulateOpen();
      await connecting;

      lastMockWs!.close(1006, 'lost');
      await vi.advanceTimersByTimeAsync(101);

      expect(kept).toHaveBeenCalledTimes(1);
      expect(detached).not.toHaveBeenCalled();
    } finally {
      mathRandom.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('backpressure is expressed in seconds of audio (TASK-985 M-36)', () => {
  it('reports the backlog as a duration, and the default watermark is ~4 s rather than ~33 s', async () => {
    const client = new SttWebSocketClient(createMockLogger());
    const ws = await connected(client);

    ws.bufferedAmount = SttWebSocketClient.PCM_BYTES_PER_SECOND * 2;
    expect(client.getBufferedAudioSeconds()).toBeCloseTo(2, 5);

    const watermarkSeconds = SttWebSocketClient.DEFAULT_BUFFERED_AMOUNT_HIGH_WATERMARK / SttWebSocketClient.PCM_BYTES_PER_SECOND;
    expect(watermarkSeconds).toBeGreaterThan(3);
    expect(watermarkSeconds).toBeLessThan(6);
  });
});
