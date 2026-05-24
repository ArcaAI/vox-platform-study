/**
 * SharedConnectionManager Tests
 *
 * Tests the client-side manager for multi-tab connection sharing.
 * Verifies both SharedWorker mode and fallback (direct connection) mode.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SharedConnectionManager } from '../SharedConnectionManager';
import { createMockLogger } from '../../__tests__/setup';

class MockEventSource {
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readyState = 0;
  private listeners = new Map<string, EventListener[]>();

  constructor(url: string) {
    this.url = url;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const arr = this.listeners.get(type);
    if (arr) {
      const idx = arr.indexOf(listener);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  close(): void {
    this.readyState = 2;
  }

  simulateMessage(data: string): void {
    const event = new MessageEvent('message', { data });
    this.onmessage?.(event);
  }

  simulateNamedEvent(name: string, data: string): void {
    const event = new MessageEvent(name, { data });
    const listeners = this.listeners.get(name) ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }
}

class MockWebSocket {
  url: string;
  protocols?: string | string[];
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sentMessages: unknown[] = [];

  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  send(data: unknown): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    const event = new CloseEvent('close', { code: code ?? 1000, reason: reason ?? '' });
    this.onclose?.(event);
  }

  simulateMessage(data: string): void {
    const event = new MessageEvent('message', { data });
    this.onmessage?.(event);
  }
}

describe('SharedConnectionManager', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let originalEventSource: typeof EventSource;
  let originalWebSocket: typeof WebSocket;
  let createdEventSources: MockEventSource[];
  let createdWebSockets: MockWebSocket[];

  beforeEach(() => {
    mockLogger = createMockLogger();
    createdEventSources = [];
    createdWebSockets = [];

    originalEventSource = globalThis.EventSource;
    originalWebSocket = globalThis.WebSocket;

    (globalThis as any).EventSource = class extends MockEventSource {
      constructor(url: string) {
        super(url);
        createdEventSources.push(this);
      }
    };

    (globalThis as any).WebSocket = Object.assign(
      class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          createdWebSockets.push(this);
        }
      },
      { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 },
    );
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
    globalThis.WebSocket = originalWebSocket;
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize in fallback mode when SharedWorker is not available', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);
      expect(manager.isUsingSharedWorker()).toBe(false);
      manager.dispose();
    });

    it('should report tab count of 1 in fallback mode', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);
      expect(manager.getTabCount()).toBe(1);
      manager.dispose();
    });
  });

  describe('workerUrl type — accepts both string and URL (cosmetic follow-up to TASK-280)', () => {
    let originalSharedWorker: typeof globalThis.SharedWorker | undefined;
    let capturedUrls: Array<string | URL>;

    beforeEach(() => {
      capturedUrls = [];
      originalSharedWorker = (globalThis as { SharedWorker?: typeof globalThis.SharedWorker })
        .SharedWorker;

      class MockSharedWorker {
        port: {
          onmessage: ((ev: MessageEvent) => void) | null;
          start: () => void;
          postMessage: (data: unknown) => void;
          close: () => void;
        };

        constructor(scriptURL: string | URL, _options?: WorkerOptions) {
          capturedUrls.push(scriptURL);
          this.port = {
            onmessage: null,
            start: () => undefined,
            postMessage: () => undefined,
            close: () => undefined,
          };
        }
      }

      (globalThis as unknown as { SharedWorker: typeof MockSharedWorker }).SharedWorker =
        MockSharedWorker;
    });

    afterEach(() => {
      if (originalSharedWorker === undefined) {
        delete (globalThis as { SharedWorker?: typeof globalThis.SharedWorker }).SharedWorker;
      } else {
        (globalThis as { SharedWorker?: typeof globalThis.SharedWorker }).SharedWorker =
          originalSharedWorker;
      }
    });

    it('forwards a URL instance verbatim to new SharedWorker(...)', () => {
      const workerUrl = new URL('http://localhost/worker.js');

      const manager = new SharedConnectionManager(workerUrl, mockLogger);

      expect(capturedUrls).toHaveLength(1);
      expect(capturedUrls[0]).toBeInstanceOf(URL);
      expect((capturedUrls[0] as URL).href).toBe('http://localhost/worker.js');
      expect(manager.isUsingSharedWorker()).toBe(true);
      manager.dispose();
    });

    it('forwards a string verbatim to new SharedWorker(...) (regression-pin)', () => {
      const manager = new SharedConnectionManager('http://localhost/worker.js', mockLogger);

      expect(capturedUrls).toHaveLength(1);
      expect(typeof capturedUrls[0]).toBe('string');
      expect(capturedUrls[0]).toBe('http://localhost/worker.js');
      expect(manager.isUsingSharedWorker()).toBe(true);
      manager.dispose();
    });
  });

  describe('SSE fallback mode', () => {
    it('should create an EventSource when subscribing to SSE', async () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);

      manager.subscribeSSE('job-1', {
        url: 'https://api.example.com/jobs/1/stream',
      });

      expect(createdEventSources).toHaveLength(1);
      expect(createdEventSources[0].url).toBe('https://api.example.com/jobs/1/stream');
      manager.dispose();
    });

    it('TASK-297 C-SSE-1: appends a stream ticket (not a JWT) to the SSE URL', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);

      manager.subscribeSSE('job-1', {
        url: 'https://api.example.com/jobs/1/stream',
        ticket: 'st_2a4f',
      });

      expect(createdEventSources[0].url).toBe(
        'https://api.example.com/jobs/1/stream?ticket=st_2a4f',
      );
      manager.dispose();
    });

    it('TASK-297 C-SSE-1: appends ticket with & when URL already has query params', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);

      manager.subscribeSSE('job-1', {
        url: 'https://api.example.com/jobs/1/stream?format=json',
        ticket: 'st_2a4f',
      });

      expect(createdEventSources[0].url).toBe(
        'https://api.example.com/jobs/1/stream?format=json&ticket=st_2a4f',
      );
      manager.dispose();
    });

    it('TASK-297 C-SSE-1: never embeds a JWT-shaped value in the SSE URL', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);

      // Even if a caller foolishly passes a JWT-looking string as the
      // ticket, it goes into `?ticket=`, never `?token=`. Real callers
      // must mint a server-side ticket via `POST /auth/stream-ticket`.
      manager.subscribeSSE('job-1', {
        url: 'https://api.example.com/jobs/1/stream',
        ticket: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
      });

      const builtUrl = createdEventSources[0].url;
      expect(builtUrl).not.toContain('?token=');
      expect(builtUrl).not.toContain('&token=');
      expect(builtUrl).toContain('?ticket=');
      manager.dispose();
    });

    it('should invoke onEvent callback for named SSE events', async () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);
      const onEvent = vi.fn();

      manager.subscribeSSE('job-1', {
        url: 'https://api.example.com/jobs/1/stream',
      }, { onEvent });

      await vi.waitFor(() => expect(createdEventSources).toHaveLength(1));

      createdEventSources[0].simulateNamedEvent('status', '{"status":"completed"}');

      expect(onEvent).toHaveBeenCalledWith('status', '{"status":"completed"}');
      manager.dispose();
    });

    it('should invoke onOpen callback when SSE connects', async () => {
      vi.useFakeTimers();
      const manager = new SharedConnectionManager(undefined, mockLogger);
      const onOpen = vi.fn();

      manager.subscribeSSE('job-1', {
        url: 'https://api.example.com/jobs/1/stream',
      }, { onOpen });

      await vi.advanceTimersByTimeAsync(10);

      expect(onOpen).toHaveBeenCalledOnce();
      manager.dispose();
      vi.useRealTimers();
    });

    it('should invoke onError callback on SSE error', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);
      const onError = vi.fn();

      manager.subscribeSSE('job-1', {
        url: 'https://api.example.com/jobs/1/stream',
      }, { onError });

      createdEventSources[0].simulateError();

      expect(onError).toHaveBeenCalledOnce();
      manager.dispose();
    });

    it('should close EventSource when unsubscribing', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);

      manager.subscribeSSE('job-1', {
        url: 'https://api.example.com/jobs/1/stream',
      });

      manager.unsubscribeSSE('job-1');

      expect(createdEventSources[0].readyState).toBe(2);
      manager.dispose();
    });

    it('should not create connections after dispose', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);
      manager.dispose();

      manager.subscribeSSE('job-1', {
        url: 'https://api.example.com/jobs/1/stream',
      });

      expect(createdEventSources).toHaveLength(0);
    });
  });

  describe('WebSocket fallback mode', () => {
    it('should create a WebSocket when subscribing', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);

      manager.subscribeWS('stream-1', {
        url: 'wss://api.example.com/ws/stt-v2/stream',
      });

      expect(createdWebSockets).toHaveLength(1);
      expect(createdWebSockets[0].url).toBe('wss://api.example.com/ws/stt-v2/stream');
      manager.dispose();
    });

    it('should invoke onMessage callback for WS messages', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);
      const onMessage = vi.fn();

      manager.subscribeWS('stream-1', {
        url: 'wss://api.example.com/ws/stt-v2/stream',
      }, { onMessage });

      createdWebSockets[0].simulateMessage('{"type":"transcript","text":"Hello"}');

      expect(onMessage).toHaveBeenCalledWith('{"type":"transcript","text":"Hello"}');
      manager.dispose();
    });

    it('should send data through WebSocket', async () => {
      vi.useFakeTimers();
      const manager = new SharedConnectionManager(undefined, mockLogger);

      manager.subscribeWS('stream-1', {
        url: 'wss://api.example.com/ws/stt-v2/stream',
      });

      await vi.advanceTimersByTimeAsync(10);

      manager.sendWS('stream-1', { type: 'auth', token: 'jwt' });

      expect(createdWebSockets[0].sentMessages).toHaveLength(1);
      expect(createdWebSockets[0].sentMessages[0]).toBe('{"type":"auth","token":"jwt"}');
      manager.dispose();
      vi.useRealTimers();
    });

    it('should send string data as-is through WebSocket', async () => {
      vi.useFakeTimers();
      const manager = new SharedConnectionManager(undefined, mockLogger);

      manager.subscribeWS('stream-1', {
        url: 'wss://api.example.com/ws/stt-v2/stream',
      });

      await vi.advanceTimersByTimeAsync(10);

      manager.sendWS('stream-1', 'raw-string-data');

      expect(createdWebSockets[0].sentMessages[0]).toBe('raw-string-data');
      manager.dispose();
      vi.useRealTimers();
    });

    it('should invoke onClose callback when WebSocket closes', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);
      const onClose = vi.fn();

      manager.subscribeWS('stream-1', {
        url: 'wss://api.example.com/ws/stt-v2/stream',
      }, { onClose });

      createdWebSockets[0].close(1000, 'Normal closure');

      expect(onClose).toHaveBeenCalledWith(1000, 'Normal closure');
      manager.dispose();
    });

    it('should close WebSocket when unsubscribing', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);

      manager.subscribeWS('stream-1', {
        url: 'wss://api.example.com/ws/stt-v2/stream',
      });

      manager.unsubscribeWS('stream-1');

      expect(createdWebSockets[0].readyState).toBe(3);
      manager.dispose();
    });
  });

  describe('callback registration after subscribe', () => {
    it('should allow registering SSE callbacks after subscription', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);
      const onEvent = vi.fn();

      manager.subscribeSSE('job-1', {
        url: 'https://api.example.com/jobs/1/stream',
      });

      manager.onSSEEvent('job-1', onEvent);

      createdEventSources[0].simulateNamedEvent('result', '{"data":"test"}');
      expect(onEvent).toHaveBeenCalledWith('result', '{"data":"test"}');
      manager.dispose();
    });

    it('should allow registering WS callbacks after subscription', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);
      const onMessage = vi.fn();

      manager.subscribeWS('stream-1', {
        url: 'wss://api.example.com/ws/stt-v2/stream',
      });

      manager.onWSMessage('stream-1', onMessage);

      createdWebSockets[0].simulateMessage('test-data');
      expect(onMessage).toHaveBeenCalledWith('test-data');
      manager.dispose();
    });
  });

  describe('dispose', () => {
    it('should close all SSE and WS connections on dispose', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);

      manager.subscribeSSE('sse-1', { url: 'https://api.example.com/sse/1' });
      manager.subscribeSSE('sse-2', { url: 'https://api.example.com/sse/2' });
      manager.subscribeWS('ws-1', { url: 'wss://api.example.com/ws/1' });

      manager.dispose();

      expect(createdEventSources[0].readyState).toBe(2);
      expect(createdEventSources[1].readyState).toBe(2);
      expect(createdWebSockets[0].readyState).toBe(3);
    });
  });

  describe('tab count', () => {
    it('should notify tab count changes', () => {
      const manager = new SharedConnectionManager(undefined, mockLogger);
      const callback = vi.fn();

      const unsubscribe = manager.onTabCountChange(callback);

      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
      manager.dispose();
    });
  });
});
