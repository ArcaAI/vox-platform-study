/**
 * SSEClient must use single-use stream tickets, never JWTs.
 *
 * Pre-condition: JWTs appended as `?token=` query
 * parameters leak through CDN logs, browser history, Referer headers, and
 * the Highlight.io network recorder. The replacement contract:
 *
 *   1. Before opening EventSource, POST `/auth/stream-ticket` with `{ scope }`.
 *   2. The response is `{ ticket, expiresAt, scope }`. Append `?ticket=<ticket>`
 *      to the endpoint URL.
 *   3. On reconnect, fetch a FRESH ticket — never reuse the previous one.
 *   4. Tickets are held only in memory; never written to localStorage,
 *      sessionStorage, IndexedDB, cookies, or persisted in any way.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SSEClient } from '../SSEClient';
import { AUTH_ENDPOINTS } from '../constants';
import { createMockLogger } from '../../__tests__/setup';

// Pure-microtask flusher (no setTimeout dependency).
async function flushPromises(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Mock EventSource — same shape used by SSEClient.test.ts
// ---------------------------------------------------------------------------

type MockEventSourceListener = (event: MessageEvent) => void;

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
  addEventListener(type: string, listener: MockEventSourceListener): void {
    (this.listeners[type] ||= []).push(listener);
  }
  removeEventListener(type: string, listener: MockEventSourceListener): void {
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
  simulateError(): void {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }
}

const originalEventSource = globalThis.EventSource;
const originalLocalStorage = globalThis.localStorage;
const originalSessionStorage = globalThis.sessionStorage;
let lastMockES: MockEventSource | null = null;
let eventSourceCtorSpy: ReturnType<typeof vi.fn<(url: string, init?: EventSourceInit) => void>>;
let lsSetItemSpy: ReturnType<typeof vi.fn>;
let ssSetItemSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  lastMockES = null;
  eventSourceCtorSpy = vi.fn<(url: string, init?: EventSourceInit) => void>();
  (globalThis as any).EventSource = class extends MockEventSource {
    constructor(url: string, init?: EventSourceInit) {
      super(url, init);
      lastMockES = this;
      eventSourceCtorSpy(url, init);
    }
  };

  lsSetItemSpy = vi.fn();
  ssSetItemSpy = vi.fn();
  (globalThis as any).localStorage = { ...originalLocalStorage, setItem: lsSetItemSpy };
  (globalThis as any).sessionStorage = { ...originalSessionStorage, setItem: ssSetItemSpy };
});

afterEach(() => {
  globalThis.EventSource = originalEventSource;
  (globalThis as any).localStorage = originalLocalStorage;
  (globalThis as any).sessionStorage = originalSessionStorage;
  lastMockES = null;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApiClient(ticketResponses: Array<{ ticket: string; expiresAt?: string; scope?: string }>) {
  let i = 0;
  const post = vi.fn(async (_url: string, _body: unknown) => {
    const r = ticketResponses[Math.min(i, ticketResponses.length - 1)];
    i++;
    return r;
  });
  return {
    post,
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

describe('SSEClient ticket-based auth', () => {
  it('POSTs /auth/stream-ticket with the scope passed at construction', async () => {
    const apiClient = makeApiClient([{ ticket: 'TKT-1', scope: 'consultation-jobs' }]);
    const client = new SSEClient('consultation-jobs', apiClient as never, createMockLogger());

    client.connect('https://api.example.com/api/v1/consultations/jobs/job-1/stream');

    await flushPromises();
    await flushPromises();

    expect(apiClient.post).toHaveBeenCalledWith('/auth/stream-ticket', { scope: 'consultation-jobs' });
    client.disconnect();
  });

  it('builds EventSource URL with ?ticket=<ticket> (never with token=)', async () => {
    const apiClient = makeApiClient([{ ticket: 'TKT-ABC-123' }]);
    const client = new SSEClient('jobs', apiClient as never, createMockLogger());

    client.connect('https://api.example.com/stream');
    await flushPromises();
    await flushPromises();

    expect(lastMockES).not.toBeNull();
    expect(lastMockES!.url).toContain('?ticket=TKT-ABC-123');
    expect(lastMockES!.url).not.toContain('token=');
    client.disconnect();
  });

  it('preserves existing query string and appends ticket with &', async () => {
    const apiClient = makeApiClient([{ ticket: 'TKT-9' }]);
    const client = new SSEClient('jobs', apiClient as never, createMockLogger());

    client.connect('https://api.example.com/stream?foo=bar');
    await flushPromises();
    await flushPromises();

    expect(lastMockES!.url).toBe('https://api.example.com/stream?foo=bar&ticket=TKT-9');
    client.disconnect();
  });

  it('URL-encodes the ticket value', async () => {
    const apiClient = makeApiClient([{ ticket: 'a/b+c d' }]);
    const client = new SSEClient('jobs', apiClient as never, createMockLogger());

    client.connect('https://api.example.com/stream');
    await flushPromises();
    await flushPromises();

    expect(lastMockES!.url).toBe('https://api.example.com/stream?ticket=a%2Fb%2Bc%20d');
    client.disconnect();
  });

  it('fetches a FRESH ticket on every reconnect (never reuses)', async () => {
    vi.useFakeTimers();
    try {
      const apiClient = makeApiClient([{ ticket: 'TKT-1' }, { ticket: 'TKT-2' }, { ticket: 'TKT-3' }]);
      const client = new SSEClient('jobs', apiClient as never, createMockLogger());

      client.connect('https://api.example.com/stream', {
        autoReconnect: true,
        reconnectIntervalMs: 10,
        maxReconnectAttempts: 3,
      });

      // Initial open
      await vi.advanceTimersByTimeAsync(0);
      expect(lastMockES).not.toBeNull();
      const firstUrl = lastMockES!.url;
      expect(firstUrl).toContain('ticket=TKT-1');
      lastMockES!.simulateOpen();

      // Trigger reconnect
      lastMockES!.simulateError();
      await vi.advanceTimersByTimeAsync(60_000);

      const secondUrl = lastMockES!.url;
      expect(secondUrl).toContain('ticket=TKT-2');
      expect(secondUrl).not.toBe(firstUrl);

      // Trigger another reconnect
      lastMockES!.simulateError();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(lastMockES!.url).toContain('ticket=TKT-3');

      // /auth/stream-ticket was called 3 times — once per open.
      expect(apiClient.post).toHaveBeenCalledTimes(3);
      apiClient.post.mock.calls.forEach((call) => {
        expect(call[0]).toBe('/auth/stream-ticket');
        expect(call[1]).toEqual({ scope: 'jobs' });
      });

      client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('NEVER writes the ticket (or any field) to localStorage or sessionStorage', async () => {
    const apiClient = makeApiClient([{ ticket: 'SECRET-TICKET' }]);
    const client = new SSEClient('jobs', apiClient as never, createMockLogger());

    client.connect('https://api.example.com/stream');
    await flushPromises();
    await flushPromises();

    // Defensive: even if some test runner pre-fills storage, neither setItem
    // call must reference the ticket value.
    const lsCalls = lsSetItemSpy.mock.calls.map((c) => c.join(' '));
    const ssCalls = ssSetItemSpy.mock.calls.map((c) => c.join(' '));
    for (const c of [...lsCalls, ...ssCalls]) {
      expect(c).not.toContain('SECRET-TICKET');
      expect(c).not.toContain('stream-ticket');
    }
    client.disconnect();
  });

  it('does not contain literal "token=" in the URL under any circumstance', async () => {
    const apiClient = makeApiClient([{ ticket: 'plain-ticket' }]);
    const client = new SSEClient('jobs', apiClient as never, createMockLogger());

    client.connect('https://api.example.com/stream');
    await flushPromises();
    await flushPromises();

    expect(lastMockES!.url).not.toContain('token=');
    client.disconnect();
  });

  it('throws (or surfaces an error) when ticket fetch fails — does NOT open EventSource', async () => {
    const failingClient = {
      ...makeApiClient([]),
      post: vi.fn().mockRejectedValue(new Error('ticket endpoint down')),
    };
    const onError = vi.fn();

    const client = new SSEClient('jobs', failingClient as never, createMockLogger());
    client.onError(onError);
    client.connect('https://api.example.com/stream');

    await flushPromises();
    await flushPromises();

    // EventSource should NOT have been constructed because we never got a ticket.
    expect(eventSourceCtorSpy).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
    client.disconnect();
  });

  // -------------------------------------------------------------------------
  // Single source of truth for the ticket path
  // -------------------------------------------------------------------------

  it('exposes AUTH_ENDPOINTS.STREAM_TICKET = "/auth/stream-ticket"', () => {
    expect(AUTH_ENDPOINTS.STREAM_TICKET).toBe('/auth/stream-ticket');
  });

  it('SSEClient POSTs to AUTH_ENDPOINTS.STREAM_TICKET — not a hardcoded literal', async () => {
    const apiClient = makeApiClient([{ ticket: 'TKT-274' }]);
    const client = new SSEClient('consultation-jobs', apiClient as never, createMockLogger());

    client.connect('https://api.example.com/stream');
    await flushPromises();
    await flushPromises();

    expect(apiClient.post).toHaveBeenCalledWith(AUTH_ENDPOINTS.STREAM_TICKET, {
      scope: 'consultation-jobs',
    });
    client.disconnect();
  });

  it('throws NOT_INITIALIZED via legacy constructor when connect() is called without scope/apiClient', async () => {
    // Backward-compat: the constructor still accepts (logger?) so that
    // pre-migration callers compile, but connect() must surface a clear
    // error. See README §5 Deviations.
    const onError = vi.fn();
    const client = new (SSEClient as any)(createMockLogger()) as SSEClient;
    client.onError(onError);
    client.connect('https://api.example.com/stream');

    await flushPromises();
    await flushPromises();

    expect(eventSourceCtorSpy).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
    client.disconnect();
  });
});
