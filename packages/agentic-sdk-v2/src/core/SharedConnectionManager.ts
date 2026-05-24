/**
 * @arcaai/vox - SharedConnectionManager
 *
 * Client-side manager for interacting with the SharedConnectionWorker.
 * Each tab creates one SharedConnectionManager instance which communicates
 * with the shared worker to multiplex WebSocket and SSE connections.
 *
 * Falls back to direct connections when SharedWorker is not available
 * (e.g., in browsers that don't support it, or in non-secure contexts).
 *
 * @example
 * ```typescript
 * const manager = new SharedConnectionManager('/workers/shared-connection.js');
 *
 * // Subscribe to an SSE stream (shared across tabs)
 * manager.subscribeSSE('job-123', {
 *   url: 'https://api.example.com/jobs/123/stream',
 *   authToken: 'jwt-token',
 *   autoReconnect: true,
 * });
 *
 * manager.onSSEEvent('job-123', (eventName, data) => {
 *   console.log(`SSE ${eventName}:`, data);
 * });
 *
 * // Clean up
 * manager.unsubscribeSSE('job-123');
 * manager.dispose();
 * ```
 */

import type { ISDKLogger } from './logger';
import type { WorkerMessage, SSESubscription, WSSubscription } from './SharedConnectionWorker';

type SSEEventCallback = (eventName: string, data: string) => void;
type WSMessageCallback = (data: unknown) => void;
type ConnectionCallback = () => void;
type ErrorCallback = () => void;
type TabCountCallback = (count: number) => void;

interface SSECallbacks {
  onEvent?: SSEEventCallback;
  onOpen?: ConnectionCallback;
  onError?: ErrorCallback;
}

interface WSCallbacks {
  onMessage?: WSMessageCallback;
  onOpen?: ConnectionCallback;
  onClose?: (code: number, reason: string) => void;
  onError?: ErrorCallback;
}

interface FallbackSSE {
  eventSource: EventSource;
  callbacks: SSECallbacks;
}

interface FallbackWS {
  socket: WebSocket;
  callbacks: WSCallbacks;
}

export class SharedConnectionManager {
  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  private logger?: ISDKLogger;
  private disposed = false;
  private useSharedWorker: boolean;

  private sseCallbacks = new Map<string, SSECallbacks>();
  private wsCallbacks = new Map<string, WSCallbacks>();
  private tabCountCallbacks = new Set<TabCountCallback>();
  private tabCount = 1;

  private fallbackSSE = new Map<string, FallbackSSE>();
  private fallbackWS = new Map<string, FallbackWS>();

  constructor(workerUrl?: string | URL, logger?: ISDKLogger) {
    this.logger = logger;
    this.useSharedWorker = typeof SharedWorker !== 'undefined';

    if (this.useSharedWorker && workerUrl) {
      try {
        this.worker = new SharedWorker(workerUrl, { name: 'arcaai-connection-manager' });
        this.port = this.worker.port;
        this.port.onmessage = (e: MessageEvent) => this.handleWorkerMessage(e.data as WorkerMessage);
        this.port.start();

        this.logger?.info('SharedConnectionManager initialized with SharedWorker', {
          operation: 'constructor',
          component: 'SharedConnectionManager',
        });
      } catch (err) {
        this.logger?.warn('SharedWorker initialization failed, falling back to direct connections', {
          operation: 'constructor',
          component: 'SharedConnectionManager',
          error: err as Error,
        });
        this.useSharedWorker = false;
        this.worker = null;
        this.port = null;
      }
    } else {
      this.useSharedWorker = false;
      this.logger?.debug('SharedWorker not available, using direct connections', {
        operation: 'constructor',
        component: 'SharedConnectionManager',
      });
    }
  }

  isUsingSharedWorker(): boolean {
    return this.useSharedWorker && this.port !== null;
  }

  getTabCount(): number {
    return this.tabCount;
  }

  onTabCountChange(callback: TabCountCallback): () => void {
    this.tabCountCallbacks.add(callback);
    return () => {
      this.tabCountCallbacks.delete(callback);
    };
  }

  // =========================================================================
  // SSE
  // =========================================================================

  subscribeSSE(id: string, subscription: SSESubscription, callbacks?: SSECallbacks): void {
    if (this.disposed) return;

    if (callbacks) {
      this.sseCallbacks.set(id, callbacks);
    }

    if (this.isUsingSharedWorker()) {
      this.postMessage({ type: 'subscribe_sse', id, payload: subscription });
    } else {
      this.createFallbackSSE(id, subscription);
    }
  }

  unsubscribeSSE(id: string): void {
    if (this.isUsingSharedWorker()) {
      this.postMessage({ type: 'unsubscribe_sse', id });
    } else {
      const fb = this.fallbackSSE.get(id);
      if (fb) {
        fb.eventSource.close();
        this.fallbackSSE.delete(id);
      }
    }
    this.sseCallbacks.delete(id);
  }

  onSSEEvent(id: string, callback: SSEEventCallback): void {
    const existing = this.sseCallbacks.get(id) ?? {};
    existing.onEvent = callback;
    this.sseCallbacks.set(id, existing);
  }

  onSSEOpen(id: string, callback: ConnectionCallback): void {
    const existing = this.sseCallbacks.get(id) ?? {};
    existing.onOpen = callback;
    this.sseCallbacks.set(id, existing);
  }

  onSSEError(id: string, callback: ErrorCallback): void {
    const existing = this.sseCallbacks.get(id) ?? {};
    existing.onError = callback;
    this.sseCallbacks.set(id, existing);
  }

  // =========================================================================
  // WebSocket
  // =========================================================================

  subscribeWS(id: string, subscription: WSSubscription, callbacks?: WSCallbacks): void {
    if (this.disposed) return;

    if (callbacks) {
      this.wsCallbacks.set(id, callbacks);
    }

    if (this.isUsingSharedWorker()) {
      this.postMessage({ type: 'subscribe_ws', id, payload: subscription });
    } else {
      this.createFallbackWS(id, subscription);
    }
  }

  unsubscribeWS(id: string): void {
    if (this.isUsingSharedWorker()) {
      this.postMessage({ type: 'unsubscribe_ws', id });
    } else {
      const fb = this.fallbackWS.get(id);
      if (fb) {
        fb.socket.close(1000, 'Unsubscribed');
        this.fallbackWS.delete(id);
      }
    }
    this.wsCallbacks.delete(id);
  }

  sendWS(id: string, data: unknown): void {
    if (this.isUsingSharedWorker()) {
      this.postMessage({ type: 'ws_send', id, payload: data });
    } else {
      const fb = this.fallbackWS.get(id);
      if (fb && fb.socket.readyState === WebSocket.OPEN) {
        if (typeof data === 'string') {
          fb.socket.send(data);
        } else {
          fb.socket.send(JSON.stringify(data));
        }
      }
    }
  }

  onWSMessage(id: string, callback: WSMessageCallback): void {
    const existing = this.wsCallbacks.get(id) ?? {};
    existing.onMessage = callback;
    this.wsCallbacks.set(id, existing);
  }

  onWSOpen(id: string, callback: ConnectionCallback): void {
    const existing = this.wsCallbacks.get(id) ?? {};
    existing.onOpen = callback;
    this.wsCallbacks.set(id, existing);
  }

  onWSClose(id: string, callback: (code: number, reason: string) => void): void {
    const existing = this.wsCallbacks.get(id) ?? {};
    existing.onClose = callback;
    this.wsCallbacks.set(id, existing);
  }

  onWSError(id: string, callback: ErrorCallback): void {
    const existing = this.wsCallbacks.get(id) ?? {};
    existing.onError = callback;
    this.wsCallbacks.set(id, existing);
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  dispose(): void {
    this.disposed = true;

    for (const [id] of this.sseCallbacks) {
      this.unsubscribeSSE(id);
    }
    for (const [id] of this.wsCallbacks) {
      this.unsubscribeWS(id);
    }

    for (const [, fb] of this.fallbackSSE) {
      fb.eventSource.close();
    }
    for (const [, fb] of this.fallbackWS) {
      fb.socket.close(1000, 'Manager disposed');
    }

    this.fallbackSSE.clear();
    this.fallbackWS.clear();
    this.sseCallbacks.clear();
    this.wsCallbacks.clear();
    this.tabCountCallbacks.clear();

    if (this.port) {
      this.port.close();
      this.port = null;
    }
    this.worker = null;
  }

  // =========================================================================
  // Internal — Worker communication
  // =========================================================================

  private postMessage(message: WorkerMessage): void {
    if (this.port) {
      this.port.postMessage(message);
    }
  }

  private handleWorkerMessage(msg: WorkerMessage): void {
    switch (msg.type) {
      case 'sse_event': {
        const cbs = msg.id ? this.sseCallbacks.get(msg.id) : undefined;
        const payload = msg.payload as { event: string; data: string } | undefined;
        if (cbs?.onEvent && payload) {
          cbs.onEvent(payload.event, payload.data);
        }
        break;
      }
      case 'sse_open': {
        const cbs = msg.id ? this.sseCallbacks.get(msg.id) : undefined;
        cbs?.onOpen?.();
        break;
      }
      case 'sse_error': {
        const cbs = msg.id ? this.sseCallbacks.get(msg.id) : undefined;
        cbs?.onError?.();
        break;
      }
      case 'ws_message': {
        const cbs = msg.id ? this.wsCallbacks.get(msg.id) : undefined;
        cbs?.onMessage?.(msg.payload);
        break;
      }
      case 'ws_open': {
        const cbs = msg.id ? this.wsCallbacks.get(msg.id) : undefined;
        cbs?.onOpen?.();
        break;
      }
      case 'ws_close': {
        const cbs = msg.id ? this.wsCallbacks.get(msg.id) : undefined;
        const payload = msg.payload as { code: number; reason: string } | undefined;
        cbs?.onClose?.(payload?.code ?? 1000, payload?.reason ?? '');
        break;
      }
      case 'ws_error': {
        const cbs = msg.id ? this.wsCallbacks.get(msg.id) : undefined;
        cbs?.onError?.();
        break;
      }
      case 'tab_count': {
        const payload = msg.payload as { count: number } | undefined;
        if (payload) {
          this.tabCount = payload.count;
          for (const cb of this.tabCountCallbacks) {
            cb(payload.count);
          }
        }
        break;
      }
      case 'connection_count': {
        this.logger?.debug('Connection subscriber count updated', {
          operation: 'handleWorkerMessage',
          component: 'SharedConnectionManager',
          attributes: { id: msg.id, count: (msg.payload as { count: number })?.count },
        });
        break;
      }
      case 'pong':
        break;
      default:
        break;
    }
  }

  // =========================================================================
  // Internal — Fallback (direct connections)
  // =========================================================================

  private createFallbackSSE(id: string, sub: SSESubscription): void {
    let url = sub.url;
    if (sub.authToken) {
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}token=${encodeURIComponent(sub.authToken)}`;
    }

    const es = new EventSource(url);

    es.onopen = () => {
      this.sseCallbacks.get(id)?.onOpen?.();
    };
    es.onerror = () => {
      this.sseCallbacks.get(id)?.onError?.();
    };
    es.onmessage = (event: MessageEvent) => {
      this.sseCallbacks.get(id)?.onEvent?.('message', event.data);
    };

    const namedEvents = ['status', 'progress', 'result', 'transcript', 'error', 'complete'];
    for (const eventName of namedEvents) {
      es.addEventListener(eventName, (event: Event) => {
        const me = event as MessageEvent;
        this.sseCallbacks.get(id)?.onEvent?.(eventName, me.data);
      });
    }

    this.fallbackSSE.set(id, { eventSource: es, callbacks: {} });
  }

  private createFallbackWS(id: string, sub: WSSubscription): void {
    const ws = new WebSocket(sub.url, sub.protocols);

    ws.onopen = () => {
      this.wsCallbacks.get(id)?.onOpen?.();
    };
    ws.onerror = () => {
      this.wsCallbacks.get(id)?.onError?.();
    };
    ws.onmessage = (event: MessageEvent) => {
      this.wsCallbacks.get(id)?.onMessage?.(event.data);
    };
    ws.onclose = (event: CloseEvent) => {
      this.wsCallbacks.get(id)?.onClose?.(event.code, event.reason);
      this.fallbackWS.delete(id);
    };

    this.fallbackWS.set(id, { socket: ws, callbacks: {} });
  }
}
