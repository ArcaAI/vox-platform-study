/**
 * TASK-264 W2-1 — SSEClient must not leak event listeners across reconnects.
 *
 * Originally TASK-262 H-2 / R-13 — anonymous closures were registered via
 * `addEventListener(eventName, () => ...)` and never removed before the old
 * `EventSource` was closed. After 50 reconnects each `EventSource` accumulated
 * additional listener references.
 *
 * The fix:
 *   1. Every named listener registered via `onEvent(name, cb)` is stored in a
 *      `Map<string, EventListener>`.
 *   2. When `createEventSource()` is called, the stored listener is attached
 *      and the reference is kept.
 *   3. When `close()` is called on the underlying `EventSource`, every stored
 *      listener is removed via `removeEventListener` first.
 *
 * Regression test: open/close 50 times and assert the
 * `addEventListener` / `removeEventListener` calls balance and that no
 * EventSource instance retains more than the expected number of listeners.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SSEClient } from '../SSEClient';
import { createMockLogger } from '../../__tests__/setup';

// Pure-microtask flusher (no setTimeout dependency).
async function flushPromises(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Mock EventSource — instrumented to count listener registrations.
// ---------------------------------------------------------------------------

interface InstrumentedEventSource extends EventSource {
  __addCalls: Array<[string, EventListener]>;
  __removeCalls: Array<[string, EventListener]>;
  __closed: boolean;
  __listenerCount: () => number;
  simulateOpen: () => void;
}

const created: InstrumentedEventSource[] = [];
const originalEventSource = globalThis.EventSource;

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  url: string;
  readyState: number = MockEventSource.CONNECTING;
  withCredentials = false;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  __addCalls: Array<[string, EventListener]> = [];
  __removeCalls: Array<[string, EventListener]> = [];
  __closed = false;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: EventListener): void {
    this.__addCalls.push([type, listener]);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.__removeCalls.push([type, listener]);
    this.listeners.get(type)?.delete(listener);
  }
  close(): void {
    this.__closed = true;
    this.readyState = MockEventSource.CLOSED;
  }
  __listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  simulateOpen(): void {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }
}

beforeEach(() => {
  created.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = class extends MockEventSource {
    constructor(url: string) {
      super(url);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      created.push(this as any as InstrumentedEventSource);
    }
  };
});

afterEach(() => {
  globalThis.EventSource = originalEventSource;
});

function makeApiClient() {
  let i = 0;
  return {
    post: vi.fn(async () => ({ ticket: `TKT-${++i}` })),
    get: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    postFormData: vi.fn(),
    getBaseUrl: () => 'https://api.example.com',
    getAccessToken: vi.fn(),
    updateAccessToken: vi.fn(),
    clearAccessToken: vi.fn(),
    getApiKey: vi.fn(),
    updateApiKey: vi.fn(),
    clearApiKey: vi.fn(),
    isImpersonating: vi.fn().mockReturnValue(false),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TASK-264 W2-1: SSEClient listener leak fix', () => {
  it('disconnect() removes every named listener it previously added to the EventSource', async () => {
    const apiClient = makeApiClient();
    const client = new SSEClient('jobs', apiClient as never, createMockLogger());

    client.onEvent('status', () => {});
    client.onEvent('progress', () => {});
    client.onEvent('result', () => {});

    client.connect('https://api.example.com/stream');
    await flushPromises();
    await flushPromises();

    expect(created.length).toBe(1);
    const es = created[0]!;
    expect(es.__listenerCount()).toBe(3);

    client.disconnect();

    // After disconnect, the underlying EventSource must have NO leftover listeners.
    expect(es.__listenerCount()).toBe(0);
    expect(es.__closed).toBe(true);
  });

  it('does not accumulate listeners across 50 open/close cycles (stress test)', async () => {
    const apiClient = makeApiClient();

    // Track the highest listener count ever observed on a single EventSource.
    let maxListenersEver = 0;

    for (let cycle = 0; cycle < 50; cycle++) {
      const client = new SSEClient('jobs', apiClient as never, createMockLogger());
      client.onEvent('status', () => {});
      client.onEvent('progress', () => {});
      client.connect('https://api.example.com/stream');
      await flushPromises();
      await flushPromises();
      const es = created[created.length - 1]!;
      maxListenersEver = Math.max(maxListenersEver, es.__listenerCount());
      client.disconnect();
      // After disconnect, the EventSource must be drained.
      expect(es.__listenerCount()).toBe(0);
    }

    // Each open registers exactly the listeners we declared (2 named). No
    // accumulation across cycles.
    expect(maxListenersEver).toBeLessThanOrEqual(2);
  });

  it('does not accumulate listeners on the SAME client across many reconnects', async () => {
    vi.useFakeTimers();
    try {
      const apiClient = makeApiClient();
      const client = new SSEClient('jobs', apiClient as never, createMockLogger());
      client.onEvent('status', () => {});
      client.onEvent('progress', () => {});

      client.connect('https://api.example.com/stream', {
        autoReconnect: true,
        reconnectIntervalMs: 1,
        maxReconnectAttempts: 50,
      });

      await vi.advanceTimersByTimeAsync(0);
      const firstEs = created[0]!;
      firstEs.simulateOpen();

      // Drive 50 reconnects.
      for (let i = 0; i < 50; i++) {
        const current = created[created.length - 1]!;
        current.simulateOpen();
        const beforeCount = current.__listenerCount();
        // The active source must never have more than 2 named listeners.
        expect(beforeCount).toBeLessThanOrEqual(2);

        // Trigger error → reconnect.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (current as any).onerror?.(new Event('error'));
        await vi.advanceTimersByTimeAsync(60_000);
      }

      // Every previously-closed EventSource should have its listeners removed.
      for (let i = 0; i < created.length - 1; i++) {
        expect(created[i]!.__listenerCount()).toBe(0);
      }

      client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});
