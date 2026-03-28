/**
 * @arcaai/vox - SSEClient
 *
 * Server-Sent Events (EventSource) client for reconnecting to job streams.
 * Used to subscribe to:
 *   - GET /api/v1/transcription-jobs/:id/stream (SSE job updates)
 *
 * Supports:
 *   - Named event listeners (e.g., 'transcript', 'status', 'progress')
 *   - Generic message listener
 *   - Auto-reconnection with configurable interval and max attempts
 *   - Clean disconnect
 *
 * @see SDK-206 Gap Analysis — ASR-R-09
 */

import type { ISDKLogger } from './logger';

/**
 * Options for SSE connection
 */
export interface SSEConnectOptions {
  /** Enable automatic reconnection on error (default: false) */
  autoReconnect?: boolean;
  /** Reconnection interval in milliseconds (default: 3000) */
  reconnectIntervalMs?: number;
  /** Maximum reconnection attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Maximum delay cap in milliseconds for exponential backoff (default: 30000) */
  maxDelayMs?: number;
  /** Auth token appended as `?token=<value>` query parameter (EventSource doesn't support custom headers) */
  authToken?: string;
}

/**
 * SSE client for subscribing to job update streams.
 */
export class SSEClient {
  private eventSource: EventSource | null = null;
  private logger?: ISDKLogger;
  private url: string | null = null;
  private options: SSEConnectOptions = {};
  private connected = false;
  private disposed = false;
  private reconnectCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private onMessageCb?: (data: string) => void;
  private onErrorCb?: (event: Event) => void;
  private onOpenCb?: () => void;
  private namedListeners: Map<string, (data: string) => void> = new Map();

  constructor(logger?: ISDKLogger) {
    this.logger = logger;
  }

  /**
   * Connect to an SSE endpoint.
   */
  connect(url: string, options: SSEConnectOptions = {}): void {
    if (this.connected && this.eventSource) {
      throw new Error('SSEClient already connected. Call disconnect() first.');
    }

    const effectiveUrl = options.authToken ? SSEClient.appendAuthToken(url, options.authToken) : url;

    this.url = effectiveUrl;
    this.options = options;
    this.disposed = false;

    this.createEventSource(effectiveUrl);
  }

  private static appendAuthToken(url: string, token: string): string {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}token=${encodeURIComponent(token)}`;
  }

  /**
   * Register a callback for generic (unnamed) messages.
   */
  onMessage(cb: (data: string) => void): void {
    this.onMessageCb = cb;
  }

  /**
   * Register a callback for a named SSE event type.
   */
  onEvent(eventName: string, cb: (data: string) => void): void {
    this.namedListeners.set(eventName, cb);

    if (this.eventSource) {
      this.attachNamedListener(this.eventSource, eventName);
    }
  }

  /**
   * Register a callback for EventSource errors.
   */
  onError(cb: (event: Event) => void): void {
    this.onErrorCb = cb;
  }

  /**
   * Register a callback for connection open.
   */
  onOpen(cb: () => void): void {
    this.onOpenCb = cb;
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get the current URL.
   */
  getUrl(): string | null {
    return this.url;
  }

  /**
   * Disconnect and clean up.
   */
  disconnect(): void {
    this.disposed = true;
    this.connected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private createEventSource(url: string): void {
    this.logger?.debug('Connecting to SSE stream', {
      operation: 'connect',
      component: 'SSEClient',
      attributes: { url },
    });

    const es = new EventSource(url);
    this.eventSource = es;

    es.onopen = () => {
      this.connected = true;
      this.reconnectCount = 0;

      this.logger?.info('SSE connection opened', {
        operation: 'connect',
        component: 'SSEClient',
        success: true,
        attributes: { url },
      });

      this.onOpenCb?.();
    };

    es.onmessage = (event: MessageEvent) => {
      this.onMessageCb?.(event.data);
    };

    es.onerror = (event: Event) => {
      this.connected = false;

      this.logger?.warn('SSE connection error', {
        operation: 'onerror',
        component: 'SSEClient',
        attributes: { url, reconnectCount: this.reconnectCount },
      });

      this.onErrorCb?.(event);

      this.attemptReconnect();
    };

    for (const [name] of this.namedListeners) {
      this.attachNamedListener(es, name);
    }
  }

  private attachNamedListener(es: EventSource, eventName: string): void {
    es.addEventListener(eventName, ((event: MessageEvent) => {
      const cb = this.namedListeners.get(eventName);
      cb?.(event.data);
    }) as EventListener);
  }

  private attemptReconnect(): void {
    if (this.disposed) return;
    if (!this.options.autoReconnect) return;

    const maxAttempts = this.options.maxReconnectAttempts ?? 10;
    if (this.reconnectCount >= maxAttempts) {
      this.logger?.error('SSE max reconnect attempts reached', {
        operation: 'reconnect',
        component: 'SSEClient',
        attributes: {
          reconnectCount: this.reconnectCount,
          maxAttempts,
        },
      });
      return;
    }

    this.reconnectCount++;
    const baseInterval = this.options.reconnectIntervalMs ?? 3000;
    const maxDelayMs = this.options.maxDelayMs ?? 30000;
    const exponentialDelay = baseInterval * Math.pow(2, this.reconnectCount - 1);
    const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
    const jitter = Math.random() * cappedDelay * 0.5;
    const interval = Math.round(cappedDelay + jitter);

    this.logger?.debug('Scheduling SSE reconnect', {
      operation: 'reconnect',
      component: 'SSEClient',
      attributes: {
        attempt: this.reconnectCount,
        maxAttempts,
        intervalMs: interval,
      },
    });

    this.reconnectTimer = setTimeout(() => {
      if (this.disposed || !this.url) return;

      // Close old EventSource before creating new one
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }

      this.createEventSource(this.url);
    }, interval);
  }
}
