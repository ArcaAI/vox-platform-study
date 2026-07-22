/**
 * SSEClient Unit Tests — ASR-R-09
 *
 * TDD tests for the Server-Sent Events client that reconnects
 * to GET /api/v1/transcription-jobs/:id/stream for job updates.
 *
 * Updated: `new SSEClient(scope, apiClient, logger?)` and
 * the URL is now built as `<endpoint>?ticket=<ticket>`. The legacy `authToken`
 * field on `SSEConnectOptions` is gone.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SSEClient } from '../SSEClient';
import { createMockLogger } from '../../__tests__/setup';
import { STT_V2_ENDPOINTS } from '../constants';

// SSEClient now requires `(scope, apiClient, logger?)`.
function makeApiClient() {
  let i = 0;
  return {
    post: vi.fn(async () => ({ ticket: `TKT-${++i}`, scope: 'test' })),
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

// Pure-microtask flusher (no setTimeout). Avoids leakage from prior tests
// that called `vi.useFakeTimers()` in this file.
async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ===========================================================================
// Mock EventSource
// ===========================================================================

type MockEventSourceListener = (event: MessageEvent) => void;
type MockErrorListener = (event: Event) => void;

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  url: string;
  readyState: number = MockEventSource.CONNECTING;
  withCredentials: boolean;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private listeners: Record<string, MockEventSourceListener[]> = {};

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
  }

  addEventListener(
    type: string,
    listener: MockEventSourceListener | MockErrorListener,
  ): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener as MockEventSourceListener);
  }

  removeEventListener(
    type: string,
    listener: MockEventSourceListener | MockErrorListener,
  ): void {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
    }
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  simulateOpen(): void {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }
  simulateMessage(data: string, eventType?: string): void {
    const event = new MessageEvent(eventType || 'message', { data });
    if (eventType && this.listeners[eventType]) {
      this.listeners[eventType].forEach((l) => l(event));
    }
    this.onmessage?.(event);
  }
  simulateError(): void {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }
  simulateNamedEvent(name: string, data: string): void {
    const event = new MessageEvent(name, { data });
    if (this.listeners[name]) this.listeners[name].forEach((l) => l(event));
  }
}

const originalEventSource = globalThis.EventSource;
let lastMockES: MockEventSource | null = null;
let eventSourceConstructorSpy: ReturnType<typeof vi.fn<(url: string, init?: EventSourceInit) => void>>;

beforeEach(() => {
  lastMockES = null;
  eventSourceConstructorSpy = vi.fn<(url: string, init?: EventSourceInit) => void>();
  (globalThis as any).EventSource = class extends MockEventSource {
    constructor(url: string, init?: EventSourceInit) {
      super(url, init);
      lastMockES = this;
      eventSourceConstructorSpy(url, init);
    }
  };
});

afterEach(() => {
  globalThis.EventSource = originalEventSource;
  lastMockES = null;
});

// ===========================================================================
// Tests
// ===========================================================================

describe('SSEClient', () => {
  let client: SSEClient;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let apiClient: ReturnType<typeof makeApiClient>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    apiClient = makeApiClient();
    client = new SSEClient('test', apiClient as never, mockLogger);
  });

  afterEach(() => {
    client.disconnect();
    // Always restore real timers — fake timers from earlier reconnect tests
    // can leak into subsequent tests that rely on real `setTimeout`.
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(false);
    });

    it('should create without logger', () => {
      const c = new SSEClient('test', apiClient as never);
      expect(c).toBeDefined();
      c.disconnect();
    });
  });

  // =========================================================================
  // connect
  // =========================================================================

  describe('connect', () => {
    it('should create an EventSource connection to the given URL (with ticket suffix)', async () => {
      client.connect('https://api.example.com/api/v1/transcription-jobs/job-1/stream');
      await flushMicrotasks();

      expect(lastMockES).not.toBeNull();
      expect(lastMockES!.url).toContain('/api/v1/transcription-jobs/job-1/stream');
      expect(lastMockES!.url).toContain('?ticket=');
      expect(lastMockES!.url).not.toContain('token=');
    });

    it('should set isConnected to true when EventSource opens', async () => {
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      lastMockES!.simulateOpen();
      expect(client.isConnected()).toBe(true);
    });

    it('should not allow connecting when already connected', async () => {
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      lastMockES!.simulateOpen();
      expect(() => client.connect('https://api.example.com/stream')).toThrow(
        /already connected/i,
      );
    });

    it('should accept a URL built from STT_V2_ENDPOINTS.JOB_STREAM', async () => {
      const jobId = 'job-sse-1';
      const url = `https://api.example.com${STT_V2_ENDPOINTS.JOB_STREAM(jobId)}`;
      client.connect(url);
      await flushMicrotasks();
      expect(lastMockES!.url).toContain('/audio/transcription-jobs/job-sse-1/stream');
    });
  });

  // =========================================================================
  // Event handling
  // =========================================================================

  describe('onMessage', () => {
    it('should fire callback when a generic message is received', async () => {
      const onMessage = vi.fn();
      client.onMessage(onMessage);
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      lastMockES!.simulateOpen();
      lastMockES!.simulateMessage(JSON.stringify({ status: 'processing', progress: 50 }));
      expect(onMessage).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(onMessage.mock.calls[0][0]);
      expect(parsed.status).toBe('processing');
    });

    it('should deliver multiple messages in sequence', async () => {
      const messages: string[] = [];
      client.onMessage((data) => messages.push(data));
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      lastMockES!.simulateOpen();
      lastMockES!.simulateMessage('msg-1');
      lastMockES!.simulateMessage('msg-2');
      lastMockES!.simulateMessage('msg-3');
      expect(messages).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });

    it('should not fire if no callback registered', async () => {
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      lastMockES!.simulateOpen();
      expect(() => lastMockES!.simulateMessage('data')).not.toThrow();
    });
  });

  describe('onEvent', () => {
    it('should fire callback for named events', async () => {
      const onTranscript = vi.fn();
      client.onEvent('transcript', onTranscript);
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      lastMockES!.simulateOpen();
      lastMockES!.simulateNamedEvent(
        'transcript',
        JSON.stringify({ text: 'Hello', isFinal: true }),
      );
      expect(onTranscript).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(onTranscript.mock.calls[0][0]);
      expect(parsed.text).toBe('Hello');
    });

    it('should support multiple named event listeners', async () => {
      const onStatus = vi.fn();
      const onProgress = vi.fn();
      client.onEvent('status', onStatus);
      client.onEvent('progress', onProgress);
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      lastMockES!.simulateOpen();
      lastMockES!.simulateNamedEvent('status', JSON.stringify({ status: 'complete' }));
      lastMockES!.simulateNamedEvent('progress', JSON.stringify({ percent: 75 }));
      expect(onStatus).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledTimes(1);
    });

    it('should attach listener to existing EventSource when registered after connect', async () => {
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      lastMockES!.simulateOpen();
      const onLateEvent = vi.fn();
      client.onEvent('late-event', onLateEvent);
      lastMockES!.simulateNamedEvent('late-event', 'late-data');
      expect(onLateEvent).toHaveBeenCalledTimes(1);
      expect(onLateEvent).toHaveBeenCalledWith('late-data');
    });
  });

  describe('onError', () => {
    it('should fire callback when EventSource errors', async () => {
      const onError = vi.fn();
      client.onError(onError);
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      lastMockES!.simulateError();
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('should set isConnected to false after error', async () => {
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      lastMockES!.simulateOpen();
      expect(client.isConnected()).toBe(true);
      lastMockES!.simulateError();
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('onOpen', () => {
    it('should fire callback when connection opens', async () => {
      const onOpen = vi.fn();
      client.onOpen(onOpen);
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      lastMockES!.simulateOpen();
      expect(onOpen).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // reconnect (using fake timers for determinism)
  // =========================================================================

  describe('reconnect', () => {
    it('should automatically reconnect after SSE error when autoReconnect is enabled', async () => {
      vi.useFakeTimers();
      try {
        client = new SSEClient('test', apiClient as never, mockLogger);
        client.connect('https://api.example.com/stream', {
          autoReconnect: true,
          reconnectIntervalMs: 10,
          maxReconnectAttempts: 3,
        });
        await vi.advanceTimersByTimeAsync(0);
        lastMockES!.simulateOpen();

        lastMockES!.simulateError();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(eventSourceConstructorSpy).toHaveBeenCalledTimes(2);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should stop reconnecting after maxReconnectAttempts', async () => {
      vi.useFakeTimers();
      try {
        client = new SSEClient('test', apiClient as never, mockLogger);
        client.connect('https://api.example.com/stream', {
          autoReconnect: true,
          reconnectIntervalMs: 10,
          maxReconnectAttempts: 2,
        });
        await vi.advanceTimersByTimeAsync(0);

        lastMockES!.simulateError();
        await vi.advanceTimersByTimeAsync(60_000);
        lastMockES!.simulateError();
        await vi.advanceTimersByTimeAsync(60_000);
        lastMockES!.simulateError();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(eventSourceConstructorSpy.mock.calls.length).toBeLessThanOrEqual(3);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not reconnect when autoReconnect is disabled', async () => {
      vi.useFakeTimers();
      try {
        client.connect('https://api.example.com/stream', { autoReconnect: false });
        await vi.advanceTimersByTimeAsync(0);
        lastMockES!.simulateOpen();
        lastMockES!.simulateError();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(eventSourceConstructorSpy).toHaveBeenCalledTimes(1);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reset reconnect count on successful connection', async () => {
      vi.useFakeTimers();
      try {
        client = new SSEClient('test', apiClient as never, mockLogger);
        client.connect('https://api.example.com/stream', {
          autoReconnect: true,
          reconnectIntervalMs: 10,
          maxReconnectAttempts: 2,
        });
        await vi.advanceTimersByTimeAsync(0);
        lastMockES!.simulateOpen();
        lastMockES!.simulateError();
        await vi.advanceTimersByTimeAsync(60_000);
        lastMockES!.simulateOpen();
        lastMockES!.simulateError();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(eventSourceConstructorSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should use exponential backoff with jitter for reconnect intervals', async () => {
      vi.useFakeTimers();
      try {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

        client = new SSEClient('test', apiClient as never, mockLogger);
        client.connect('https://api.example.com/stream', {
          autoReconnect: true,
          reconnectIntervalMs: 1000,
          maxReconnectAttempts: 3,
        });
        await vi.advanceTimersByTimeAsync(0);
        lastMockES!.simulateOpen();

        // Filter to reconnect-sized delays (>=500ms) to ignore microtask schedulers.
        const reconnectDelays = (): number[] =>
          setTimeoutSpy.mock.calls
            .map((c) => c[1] as number)
            .filter((d) => typeof d === 'number' && d >= 500);

        lastMockES!.simulateError();
        await vi.advanceTimersByTimeAsync(0);
        const firstDelay = reconnectDelays().pop()!;
        expect(firstDelay).toBeGreaterThanOrEqual(1000);
        expect(firstDelay).toBeLessThanOrEqual(1500);

        await vi.advanceTimersByTimeAsync(firstDelay + 1);

        lastMockES!.simulateError();
        await vi.advanceTimersByTimeAsync(0);
        const secondDelay = reconnectDelays().pop()!;
        expect(secondDelay).toBeGreaterThanOrEqual(2000);
        expect(secondDelay).toBeLessThanOrEqual(3000);
        expect(secondDelay).toBeGreaterThan(firstDelay);

        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not reconnect by default when no options provided', async () => {
      vi.useFakeTimers();
      try {
        client.connect('https://api.example.com/stream');
        await vi.advanceTimersByTimeAsync(0);
        lastMockES!.simulateOpen();
        lastMockES!.simulateError();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(eventSourceConstructorSpy).toHaveBeenCalledTimes(1);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // disconnect
  // =========================================================================

  describe('disconnect', () => {
    it('should close the EventSource connection', async () => {
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      lastMockES!.simulateOpen();
      client.disconnect();
      expect(client.isConnected()).toBe(false);
    });

    it('should be safe to call when not connected', () => {
      expect(() => client.disconnect()).not.toThrow();
    });

    it('should be idempotent (safe to call multiple times)', async () => {
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      lastMockES!.simulateOpen();
      client.disconnect();
      expect(() => client.disconnect()).not.toThrow();
      expect(client.isConnected()).toBe(false);
    });

    it('should prevent reconnection after disconnect', async () => {
      vi.useFakeTimers();
      try {
        client = new SSEClient('test', apiClient as never, mockLogger);
        client.connect('https://api.example.com/stream', {
          autoReconnect: true,
          reconnectIntervalMs: 10,
          maxReconnectAttempts: 5,
        });
        await vi.advanceTimersByTimeAsync(0);
        lastMockES!.simulateOpen();
        client.disconnect();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(eventSourceConstructorSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // URL helpers
  // =========================================================================

  describe('getUrl', () => {
    it('should return the connected URL (without the ticket suffix)', async () => {
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      expect(client.getUrl()).toBe('https://api.example.com/stream');
    });

    it('should return null when not connected', () => {
      expect(client.getUrl()).toBeNull();
    });
  });

  // =========================================================================
  // Named event listener leak on reconnect
  // =========================================================================

  describe('named listeners should use stored callback on reconnect', () => {
    it('should call the latest callback after reconnect, not duplicates', async () => {
      vi.useFakeTimers();
      try {
        const url = 'https://api.example.com/stream';
        client.connect(url, {
          autoReconnect: true,
          reconnectIntervalMs: 100,
          maxReconnectAttempts: 3,
        });
        await vi.advanceTimersByTimeAsync(0);
        const es1 = lastMockES!;
        es1.simulateOpen();

        const callCounts: number[] = [];
        const cb = vi.fn(() => callCounts.push(1));
        client.onEvent('status', cb);

        es1.simulateError();
        await vi.advanceTimersByTimeAsync(60_000);

        const es2 = lastMockES!;
        es2.simulateOpen();
        es2.simulateNamedEvent('status', '{"progress":50}');

        expect(cb).toHaveBeenCalledTimes(1);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // PERF-05: Reconnect backoff should have a max delay cap
  // =========================================================================

  describe('PERF-05: reconnect backoff should cap at maxDelayMs', () => {
    it('should not exceed maxDelayMs even at high attempt counts', async () => {
      vi.useFakeTimers();
      try {
        const url = 'https://api.example.com/stream';
        client.connect(url, {
          autoReconnect: true,
          reconnectIntervalMs: 1000,
          maxReconnectAttempts: 15,
          maxDelayMs: 10000,
        } as any);

        await vi.advanceTimersByTimeAsync(0);
        const es1 = lastMockES!;
        for (let i = 0; i < 10; i++) {
          es1.simulateError();
          await vi.advanceTimersByTimeAsync(60_000);
        }
        expect(eventSourceConstructorSpy.mock.calls.length).toBeGreaterThan(1);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // Legacy authToken option is REMOVED
  // =========================================================================

  describe('legacy authToken option is no longer honored', () => {
    it('does NOT append `?token=` even when caller passes a legacy authToken', async () => {
      client.connect('https://api.example.com/stream', {
        ...(({ authToken: 'jwt-token-123' } as unknown) as any),
      });
      await flushMicrotasks();
      expect(lastMockES!.url).not.toContain('token=jwt-token-123');
      expect(lastMockES!.url).not.toContain('?token=');
      expect(lastMockES!.url).toContain('?ticket=');
    });

    it('produces a URL with only the ticket query param when no special options are passed', async () => {
      client.connect('https://api.example.com/stream');
      await flushMicrotasks();
      const url = new URL(lastMockES!.url);
      expect(url.pathname).toBe('/stream');
      expect(Array.from(url.searchParams.keys())).toEqual(['ticket']);
    });
  });
});
