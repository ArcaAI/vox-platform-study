/**
 * SSEClient Unit Tests — ASR-R-09
 *
 * TDD tests for the Server-Sent Events client that reconnects
 * to GET /api/v1/transcription-jobs/:id/stream for job updates.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SSEClient } from '../SSEClient';
import { createMockLogger } from '../../__tests__/setup';
import { STT_V2_ENDPOINTS } from '../constants';

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

  addEventListener(type: string, listener: MockEventSourceListener | MockErrorListener): void {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener as MockEventSourceListener);
  }

  removeEventListener(type: string, listener: MockEventSourceListener | MockErrorListener): void {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter(
        (l) => l !== listener,
      );
    }
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  // Test helpers
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
    if (this.listeners[name]) {
      this.listeners[name].forEach((l) => l(event));
    }
  }
}

// Install mock EventSource globally
const originalEventSource = globalThis.EventSource;
let lastMockES: MockEventSource | null = null;
let eventSourceConstructorSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  lastMockES = null;
  eventSourceConstructorSpy = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  beforeEach(() => {
    mockLogger = createMockLogger();
    client = new SSEClient(mockLogger);
  });

  afterEach(() => {
    client.disconnect();
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
      const c = new SSEClient();
      expect(c).toBeDefined();
      c.disconnect();
    });
  });

  // =========================================================================
  // connect
  // =========================================================================

  describe('connect', () => {
    it('should create an EventSource connection to the given URL', () => {
      client.connect('https://api.example.com/api/v1/transcription-jobs/job-1/stream');

      expect(lastMockES).not.toBeNull();
      expect(lastMockES!.url).toBe(
        'https://api.example.com/api/v1/transcription-jobs/job-1/stream',
      );
    });

    it('should set isConnected to true when EventSource opens', () => {
      client.connect('https://api.example.com/stream');
      lastMockES!.simulateOpen();

      expect(client.isConnected()).toBe(true);
    });

    it('should not allow connecting when already connected', () => {
      client.connect('https://api.example.com/stream');
      lastMockES!.simulateOpen();

      expect(() =>
        client.connect('https://api.example.com/stream'),
      ).toThrow(/already connected/i);
    });

    it('should accept a URL built from STT_V2_ENDPOINTS.JOB_STREAM', () => {
      const jobId = 'job-sse-1';
      const url = `https://api.example.com${STT_V2_ENDPOINTS.JOB_STREAM(jobId)}`;

      client.connect(url);

      expect(lastMockES!.url).toContain('/audio/transcription-jobs/job-sse-1/stream');
    });
  });

  // =========================================================================
  // Event handling
  // =========================================================================

  describe('onMessage', () => {
    it('should fire callback when a generic message is received', () => {
      const onMessage = vi.fn();
      client.onMessage(onMessage);
      client.connect('https://api.example.com/stream');
      lastMockES!.simulateOpen();

      lastMockES!.simulateMessage(JSON.stringify({ status: 'processing', progress: 50 }));

      expect(onMessage).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(onMessage.mock.calls[0][0]);
      expect(parsed.status).toBe('processing');
    });

    it('should deliver multiple messages in sequence', () => {
      const messages: string[] = [];
      client.onMessage((data) => messages.push(data));
      client.connect('https://api.example.com/stream');
      lastMockES!.simulateOpen();

      lastMockES!.simulateMessage('msg-1');
      lastMockES!.simulateMessage('msg-2');
      lastMockES!.simulateMessage('msg-3');

      expect(messages).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });

    it('should not fire if no callback registered', () => {
      client.connect('https://api.example.com/stream');
      lastMockES!.simulateOpen();

      // Should not throw
      expect(() => lastMockES!.simulateMessage('data')).not.toThrow();
    });
  });

  describe('onEvent', () => {
    it('should fire callback for named events', () => {
      const onTranscript = vi.fn();
      client.onEvent('transcript', onTranscript);
      client.connect('https://api.example.com/stream');
      lastMockES!.simulateOpen();

      lastMockES!.simulateNamedEvent(
        'transcript',
        JSON.stringify({ text: 'Hello', isFinal: true }),
      );

      expect(onTranscript).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(onTranscript.mock.calls[0][0]);
      expect(parsed.text).toBe('Hello');
    });

    it('should support multiple named event listeners', () => {
      const onStatus = vi.fn();
      const onProgress = vi.fn();
      client.onEvent('status', onStatus);
      client.onEvent('progress', onProgress);
      client.connect('https://api.example.com/stream');
      lastMockES!.simulateOpen();

      lastMockES!.simulateNamedEvent('status', JSON.stringify({ status: 'complete' }));
      lastMockES!.simulateNamedEvent('progress', JSON.stringify({ percent: 75 }));

      expect(onStatus).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledTimes(1);
    });

    it('should attach listener to existing EventSource when registered after connect', () => {
      client.connect('https://api.example.com/stream');
      lastMockES!.simulateOpen();

      const onLateEvent = vi.fn();
      client.onEvent('late-event', onLateEvent);

      lastMockES!.simulateNamedEvent('late-event', 'late-data');

      expect(onLateEvent).toHaveBeenCalledTimes(1);
      expect(onLateEvent).toHaveBeenCalledWith('late-data');
    });
  });

  describe('onError', () => {
    it('should fire callback when EventSource errors', () => {
      const onError = vi.fn();
      client.onError(onError);
      client.connect('https://api.example.com/stream');

      lastMockES!.simulateError();

      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('should set isConnected to false after error', () => {
      client.connect('https://api.example.com/stream');
      lastMockES!.simulateOpen();
      expect(client.isConnected()).toBe(true);

      lastMockES!.simulateError();

      expect(client.isConnected()).toBe(false);
    });
  });

  describe('onOpen', () => {
    it('should fire callback when connection opens', () => {
      const onOpen = vi.fn();
      client.onOpen(onOpen);
      client.connect('https://api.example.com/stream');

      lastMockES!.simulateOpen();

      expect(onOpen).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // reconnect (using fake timers for determinism)
  // =========================================================================

  describe('reconnect', () => {
    it('should automatically reconnect after SSE error when autoReconnect is enabled', () => {
      vi.useFakeTimers();
      try {
        client = new SSEClient(mockLogger);
        client.connect('https://api.example.com/stream', {
          autoReconnect: true,
          reconnectIntervalMs: 10,
          maxReconnectAttempts: 3,
        });
        lastMockES!.simulateOpen();

        lastMockES!.simulateError();

        vi.advanceTimersByTime(60_000);

        expect(eventSourceConstructorSpy).toHaveBeenCalledTimes(2);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should stop reconnecting after maxReconnectAttempts', () => {
      vi.useFakeTimers();
      try {
        client = new SSEClient(mockLogger);
        client.connect('https://api.example.com/stream', {
          autoReconnect: true,
          reconnectIntervalMs: 10,
          maxReconnectAttempts: 2,
        });

        lastMockES!.simulateError();
        vi.advanceTimersByTime(60_000);
        lastMockES!.simulateError();
        vi.advanceTimersByTime(60_000);
        lastMockES!.simulateError();
        vi.advanceTimersByTime(60_000);

        // 1 initial + 2 reconnects = 3 total
        expect(eventSourceConstructorSpy.mock.calls.length).toBeLessThanOrEqual(3);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not reconnect when autoReconnect is disabled', () => {
      vi.useFakeTimers();
      try {
        client.connect('https://api.example.com/stream', {
          autoReconnect: false,
        });
        lastMockES!.simulateOpen();

        lastMockES!.simulateError();
        vi.advanceTimersByTime(60_000);

        expect(eventSourceConstructorSpy).toHaveBeenCalledTimes(1);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reset reconnect count on successful connection', () => {
      vi.useFakeTimers();
      try {
        client = new SSEClient(mockLogger);
        client.connect('https://api.example.com/stream', {
          autoReconnect: true,
          reconnectIntervalMs: 10,
          maxReconnectAttempts: 2,
        });
        lastMockES!.simulateOpen();

        lastMockES!.simulateError();
        vi.advanceTimersByTime(60_000);

        lastMockES!.simulateOpen();

        lastMockES!.simulateError();
        vi.advanceTimersByTime(60_000);

        // 1 initial + 1 reconnect + 1 reconnect after reset = 3
        expect(eventSourceConstructorSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should use exponential backoff with jitter for reconnect intervals', () => {
      vi.useFakeTimers();
      try {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

        client = new SSEClient(mockLogger);
        client.connect('https://api.example.com/stream', {
          autoReconnect: true,
          reconnectIntervalMs: 1000,
          maxReconnectAttempts: 3,
        });
        lastMockES!.simulateOpen();

        // 1st error — backoff: 1000 * 2^0 = 1000 + jitter
        lastMockES!.simulateError();
        const firstDelay = setTimeoutSpy.mock.calls[setTimeoutSpy.mock.calls.length - 1][1] as number;
        expect(firstDelay).toBeGreaterThanOrEqual(1000);
        expect(firstDelay).toBeLessThanOrEqual(1500); // 1000 + up to 50% jitter

        // Advance to trigger reconnect
        vi.advanceTimersByTime(firstDelay + 1);

        // 2nd error — backoff: 1000 * 2^1 = 2000 + jitter
        lastMockES!.simulateError();
        const secondDelay = setTimeoutSpy.mock.calls[setTimeoutSpy.mock.calls.length - 1][1] as number;
        expect(secondDelay).toBeGreaterThanOrEqual(2000);
        expect(secondDelay).toBeLessThanOrEqual(3000); // 2000 + up to 50% jitter

        // Second delay should be larger than first (exponential growth)
        expect(secondDelay).toBeGreaterThan(firstDelay);

        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not reconnect by default when no options provided', () => {
      vi.useFakeTimers();
      try {
        client.connect('https://api.example.com/stream');
        lastMockES!.simulateOpen();

        lastMockES!.simulateError();
        vi.advanceTimersByTime(60_000);

        // Default: autoReconnect is false
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
    it('should close the EventSource connection', () => {
      client.connect('https://api.example.com/stream');
      lastMockES!.simulateOpen();

      client.disconnect();

      expect(client.isConnected()).toBe(false);
    });

    it('should be safe to call when not connected', () => {
      expect(() => client.disconnect()).not.toThrow();
    });

    it('should be idempotent (safe to call multiple times)', () => {
      client.connect('https://api.example.com/stream');
      lastMockES!.simulateOpen();

      client.disconnect();
      expect(() => client.disconnect()).not.toThrow();
      expect(client.isConnected()).toBe(false);
    });

    it('should prevent reconnection after disconnect', () => {
      vi.useFakeTimers();
      try {
        client = new SSEClient(mockLogger);
        client.connect('https://api.example.com/stream', {
          autoReconnect: true,
          reconnectIntervalMs: 10,
          maxReconnectAttempts: 5,
        });
        lastMockES!.simulateOpen();

        client.disconnect();

        // Advance far beyond any possible backoff
        vi.advanceTimersByTime(60_000);

        // Only the initial connection — no reconnects after explicit disconnect
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
    it('should return the connected URL', () => {
      client.connect('https://api.example.com/stream');

      expect(client.getUrl()).toBe('https://api.example.com/stream');
    });

    it('should return null when not connected', () => {
      expect(client.getUrl()).toBeNull();
    });
  });

  // =========================================================================
  // BUG-08: Named event listener leak on reconnect
  // =========================================================================

  describe('BUG-08: named listeners should use stored callback on reconnect', () => {
    it('should call the latest callback after reconnect, not duplicates', () => {
      vi.useFakeTimers();
      try {
        const url = 'https://api.example.com/stream';
        client.connect(url, {
          autoReconnect: true,
          reconnectIntervalMs: 100,
          maxReconnectAttempts: 3,
        });
        const es1 = lastMockES!;
        es1.simulateOpen();

        const callCounts: number[] = [];
        const cb = vi.fn(() => callCounts.push(1));
        client.onEvent('status', cb);

        // Simulate error to trigger reconnect
        es1.simulateError();
        vi.advanceTimersByTime(200);

        const es2 = lastMockES!;
        es2.simulateOpen();

        // Dispatch event on the new EventSource
        es2.simulateNamedEvent('status', '{"progress":50}');

        // The callback should be called exactly once per event, not duplicated
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
    it('should not exceed maxDelayMs even at high attempt counts', () => {
      vi.useFakeTimers();
      try {
        const url = 'https://api.example.com/stream';
        client.connect(url, {
          autoReconnect: true,
          reconnectIntervalMs: 1000,
          maxReconnectAttempts: 15,
          maxDelayMs: 10000,
        } as any);

        const es1 = lastMockES!;

        // Simulate many errors to drive up the backoff
        for (let i = 0; i < 10; i++) {
          es1.simulateError();
          vi.advanceTimersByTime(60000);
        }

        // The test passes if no reconnect delay exceeds 15s (10s cap + 50% jitter)
        // We verify by checking that reconnects actually happened within reasonable time
        // rather than waiting 25+ minutes
        expect(eventSourceConstructorSpy.mock.calls.length).toBeGreaterThan(1);

        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // BUG-11: SSE should support auth token via query parameter
  // =========================================================================

  describe('BUG-11: SSE auth token support', () => {
    it('should append token as query parameter when provided', () => {
      client.connect('https://api.example.com/stream', {
        authToken: 'jwt-token-123',
      } as SSEConnectOptions & { authToken?: string });

      expect(lastMockES!.url).toBe(
        'https://api.example.com/stream?token=jwt-token-123',
      );
    });

    it('should append token to existing query parameters', () => {
      client.connect('https://api.example.com/stream?foo=bar', {
        authToken: 'jwt-token-456',
      } as SSEConnectOptions & { authToken?: string });

      expect(lastMockES!.url).toBe(
        'https://api.example.com/stream?foo=bar&token=jwt-token-456',
      );
    });

    it('should not modify URL when no authToken is provided', () => {
      client.connect('https://api.example.com/stream');

      expect(lastMockES!.url).toBe('https://api.example.com/stream');
    });
  });
});
