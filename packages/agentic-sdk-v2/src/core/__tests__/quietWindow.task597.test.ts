/**
 * Stop-drain QUIET WINDOW threading.
 *
 * `SttWebSocketClient` has always supported `quietWindowMs`, but only at
 * construction — nothing per-capture could reach it, so the documented
 * "`quietWindowMs: 0` disables the early resolve" was unreachable from an app.
 * This pins the two hops that live in `@arcaai/vox`:
 *
 *   AudioStartOptions → PluginManager runtime options → STTStreamingTransport
 *   stopAndDrain(timeout, quietWindow) → the drain's early-resolve behaviour
 *
 * The load-bearing property throughout is that **`0` survives**. Every other
 * knob on this path is guarded with `> 0`, so the obvious (and wrong) thing to
 * write here is a truthiness check — which would silently discard exactly the
 * value a caller sets deliberately. Each hop is asserted with `0`, not just
 * with a "nice" number.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginManager } from '../PluginManager';
import { SttWebSocketClient } from '../SttWebSocketClient';
import { createMockLogger } from '../../__tests__/setup';
import type { AgenticClient } from '../AgenticClient';

vi.mock('@arcaai/noise-filter', () => ({ createNoiseFilter: vi.fn() }));
vi.mock('@arcaai/vad', () => ({ createVAD: vi.fn() }));
vi.mock('@arcaai/stt', () => ({ createSTT: vi.fn() }));
vi.mock('@arcaai/med-ner', () => ({ createMedNER: vi.fn() }));

function makeApiClient(): AgenticClient {
  return {
    post: vi.fn(),
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getBaseUrl: vi.fn(() => 'https://api.test'),
  } as unknown as AgenticClient;
}

// ===========================================================================
// Hop 1 — PluginManager runtime options → the streaming transport
// ===========================================================================
describe('PluginManager — quietWindowMs reaches the streaming transport', () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager({ stt: { enabled: true, provider: 'backend', language: 'en' } }, createMockLogger(), makeApiClient(), false);
  });

  function transportFor(runtime: Record<string, unknown>) {
    manager.setRuntimeOptions({ pipelineId: 'pipe-1', ...runtime });
    return manager.getTranscriptionPipelineConfig().stt.streamingTransport as { quietWindowMs?: number } | undefined;
  }

  it('PRESERVES quietWindowMs: 0 — a truthiness guard here would drop the disable', () => {
    const transport = transportFor({ quietWindowMs: 0 });
    expect(transport).toBeTruthy();
    expect(transport).toHaveProperty('quietWindowMs', 0);
  });

  it('forwards a positive quietWindowMs', () => {
    expect(transportFor({ quietWindowMs: 2000 })).toHaveProperty('quietWindowMs', 2000);
  });

  it('omits the key entirely when unset, so the client default applies', () => {
    expect(transportFor({})).not.toHaveProperty('quietWindowMs');
  });

  it.each([-1, Number.NaN])('drops a meaningless value (%p)', (value) => {
    expect(transportFor({ quietWindowMs: value })).not.toHaveProperty('quietWindowMs');
  });
});

// ===========================================================================
// Hop 2 — stopAndDrain honours the per-call override
// ===========================================================================
describe('SttWebSocketClient.stopAndDrain — per-call quietWindowMs', () => {
  let sockets: MockSocket[];

  class MockSocket {
    static readonly OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    onmessage: ((ev: { data: string }) => void) | null = null;
    onopen: (() => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
    /** Deliver a server frame through the client's real message handler. */
    emit(payload: unknown) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
  }

  beforeEach(() => {
    sockets = [];
    vi.useFakeTimers();
    vi.stubGlobal(
      'WebSocket',
      Object.assign(MockSocket, { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 }) as unknown as typeof WebSocket,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function connected() {
    const client = new SttWebSocketClient(createMockLogger());
    const opening = client.connect('wss://api.test/ws/stt/stream?sessionId=s1&ticket=t1&tenantId=t-1');
    await vi.advanceTimersByTimeAsync(0);
    await opening;
    return { client, socket: sockets[0]! };
  }

  it('quietWindowMs: 0 DISABLES the early resolve — finalizing no longer ends the drain', async () => {
    const { client, socket } = await connected();

    // Long ceiling so the ONLY thing that could end this drain early is the
    // quiet window we just disabled.
    const drain = client.stopAndDrain(60_000, 0);
    let settled = false;
    void drain.then(() => {
      settled = true;
    });

    socket.emit({ type: 'status', status: 'finalizing' });
    // Far beyond the 250 ms default quiet window.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    // The terminal status is still honoured.
    socket.emit({ type: 'status', status: 'closed' });
    await vi.advanceTimersByTimeAsync(0);
    await drain;
    expect(settled).toBe(true);
  });

  it('POSITIVE CONTROL — the default quiet window DOES end the drain on finalizing', async () => {
    const { client, socket } = await connected();

    const drain = client.stopAndDrain(60_000);
    let settled = false;
    void drain.then(() => {
      settled = true;
    });

    socket.emit({ type: 'status', status: 'finalizing' });
    await vi.advanceTimersByTimeAsync(SttWebSocketClient.DEFAULT_DRAIN_QUIET_WINDOW_MS + 10);
    await drain;
    expect(settled).toBe(true);
  });

  it('a per-call quietWindowMs overrides the configured one', async () => {
    const client = new SttWebSocketClient(createMockLogger(), undefined, false, undefined, { quietWindowMs: 50 });
    const opening = client.connect('wss://api.test/ws/stt/stream?sessionId=s1&ticket=t1&tenantId=t-1');
    await vi.advanceTimersByTimeAsync(0);
    await opening;
    const socket = sockets[0]!;

    const drain = client.stopAndDrain(60_000, 1_000);
    let settled = false;
    void drain.then(() => {
      settled = true;
    });

    socket.emit({ type: 'status', status: 'finalizing' });
    // Past the CONFIGURED 50 ms, well short of the per-call 1000 ms.
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(900);
    await drain;
    expect(settled).toBe(true);
  });
});
