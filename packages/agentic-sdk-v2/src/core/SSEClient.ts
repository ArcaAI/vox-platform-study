/**
 * @arcaai/vox - SSEClient
 *
 * Server-Sent Events client for `EventSource`-based job/transcript streams.
 *
 * TASK-264 W0-1 (Single-use stream tickets):
 *   The previous implementation appended the user JWT to the URL as
 *   `?token=<jwt>`, which leaks the credential through Referer headers,
 *   browser history, CDN logs, and the Highlight.io network recorder
 *   (TASK-262 §2.4 SEC-A). The replacement protocol is:
 *
 *     1. At construction the caller declares the stream `scope`
 *        (e.g. `consultation-jobs`) and supplies an `AgenticClient`-shaped
 *        API client used to mint tickets.
 *     2. Immediately before every `EventSource` open — including reconnects —
 *        the client POSTs `/auth/stream-ticket` with `{ scope }` and receives
 *        `{ ticket, expiresAt, scope }`.
 *     3. The ticket is appended to the endpoint URL as `?ticket=<ticket>`
 *        (URL-encoded). The ticket is held only in memory and discarded on
 *        the next reconnect.
 *
 * TASK-264 W2-1 (No listener leaks across reconnects):
 *   Every named listener attached to an `EventSource` is now tracked in a
 *   `Map<string, EventListener>` so we can call `removeEventListener` on
 *   `close()` (both for explicit `disconnect()` and the implicit close that
 *   precedes a reconnect). The leak test
 *   (`SSEClient.leak.test.ts`) opens/closes 50 times and asserts the listener
 *   count never accumulates.
 *
 * @see docs/implementation/TASK-264-SDK-Auth-Core/README.md
 */

import type { ISDKLogger } from './logger';

/**
 * Subset of `AgenticClient` that `SSEClient` actually depends on.
 * Defining a structural type here keeps the dependency one-way and avoids a
 * circular import.
 */
export interface SSEApiClient {
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

/**
 * Shape of the response from POST `/auth/stream-ticket`.
 */
export interface StreamTicket {
  ticket: string;
  expiresAt?: string;
  scope?: string;
}

/**
 * Options for SSE connection.
 *
 * NOTE: The legacy `authToken` field was removed in TASK-264 W0-1. The only
 * authentication path is the single-use stream ticket fetched per connect.
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
}

const TICKET_ENDPOINT = '/auth/stream-ticket';

/**
 * SSE client for subscribing to job update streams.
 */
export class SSEClient {
  private readonly scope: string | null;
  private readonly apiClient: SSEApiClient | null;
  private readonly logger?: ISDKLogger;

  private eventSource: EventSource | null = null;
  /** Listener references currently attached to `this.eventSource`. */
  private attachedListeners: Map<string, EventListener> = new Map();

  /** Endpoint URL passed by the caller, *without* the ticket suffix. */
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

  /**
   * Construct an SSEClient.
   *
   * Preferred signature: `new SSEClient(scope, apiClient, logger?)`.
   *
   * A legacy signature `new SSEClient(logger?)` is still accepted at the TS
   * level so that pre-migration callers (currently `useConsultationJob`) keep
   * compiling. Such instances WILL surface a deterministic error via
   * `onError` from `connect()`. See TASK-264 README §5 (Deviations).
   */
  constructor(scope?: string | ISDKLogger, apiClient?: SSEApiClient, logger?: ISDKLogger) {
    if (typeof scope === 'string') {
      this.scope = scope;
      this.apiClient = apiClient ?? null;
      this.logger = logger;
    } else {
      this.scope = null;
      this.apiClient = null;
      this.logger = scope;
    }
  }

  connect(url: string, options: SSEConnectOptions = {}): void {
    if (this.connected && this.eventSource) {
      throw new Error('SSEClient already connected. Call disconnect() first.');
    }

    this.url = url;
    this.options = options;
    this.disposed = false;

    void this.openWithTicket(url);
  }

  onMessage(cb: (data: string) => void): void {
    this.onMessageCb = cb;
  }

  onEvent(eventName: string, cb: (data: string) => void): void {
    this.namedListeners.set(eventName, cb);

    if (this.eventSource && !this.attachedListeners.has(eventName)) {
      this.attachNamedListener(this.eventSource, eventName);
    }
  }

  onError(cb: (event: Event) => void): void {
    this.onErrorCb = cb;
  }

  onOpen(cb: () => void): void {
    this.onOpenCb = cb;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Returns the caller-supplied endpoint URL (without the ticket suffix). */
  getUrl(): string | null {
    return this.url;
  }

  disconnect(): void {
    this.disposed = true;
    this.connected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.closeEventSource();
  }

  // =========================================================================
  // Internal — ticket flow
  // =========================================================================

  private async openWithTicket(callerUrl: string): Promise<void> {
    if (this.scope === null || this.apiClient === null) {
      const message = '[SSEClient] missing scope/apiClient — caller must migrate to new SSEClient(scope, apiClient, logger?)';
      this.logger?.error?.('SSEClient legacy construction blocked', {
        operation: 'connect',
        component: 'SSEClient',
        attributes: { message },
      });
      this.onErrorCb?.(new Event('error'));
      return;
    }

    let ticket: string;
    try {
      const response = await this.apiClient.post<StreamTicket>(TICKET_ENDPOINT, {
        scope: this.scope,
      });
      ticket = response.ticket;
      if (typeof ticket !== 'string' || ticket.length === 0) {
        throw new Error('[SSEClient] /auth/stream-ticket returned no ticket');
      }
    } catch (error) {
      this.logger?.error?.('Failed to obtain SSE stream ticket', {
        operation: 'fetchTicket',
        component: 'SSEClient',
        attributes: {
          scope: this.scope,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      this.onErrorCb?.(new Event('error'));
      this.scheduleReconnect();
      return;
    }

    if (this.disposed) return;

    const fullUrl = SSEClient.appendTicket(callerUrl, ticket);
    this.createEventSource(fullUrl);
  }

  private static appendTicket(url: string, ticket: string): string {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}ticket=${encodeURIComponent(ticket)}`;
  }

  // =========================================================================
  // Internal — EventSource lifecycle
  // =========================================================================

  private createEventSource(url: string): void {
    this.logger?.debug?.('Connecting to SSE stream', {
      operation: 'connect',
      component: 'SSEClient',
      attributes: { url },
    });

    const es = new EventSource(url);
    this.eventSource = es;

    es.onopen = () => {
      this.connected = true;
      this.reconnectCount = 0;

      this.logger?.info?.('SSE connection opened', {
        operation: 'connect',
        component: 'SSEClient',
        success: true,
      });

      this.onOpenCb?.();
    };

    es.onmessage = (event: MessageEvent) => {
      this.onMessageCb?.(event.data);
    };

    es.onerror = (event: Event) => {
      this.connected = false;

      this.logger?.warn?.('SSE connection error', {
        operation: 'onerror',
        component: 'SSEClient',
        attributes: { reconnectCount: this.reconnectCount },
      });

      this.onErrorCb?.(event);

      this.scheduleReconnect();
    };

    for (const [name] of this.namedListeners) {
      this.attachNamedListener(es, name);
    }
  }

  /**
   * Attach a named-event listener and remember its reference so we can
   * `removeEventListener` it before closing the `EventSource`.
   */
  private attachNamedListener(es: EventSource, eventName: string): void {
    const listener: EventListener = (event) => {
      const cb = this.namedListeners.get(eventName);
      cb?.((event as MessageEvent).data);
    };
    es.addEventListener(eventName, listener);
    this.attachedListeners.set(eventName, listener);
  }

  private closeEventSource(): void {
    const es = this.eventSource;
    if (!es) return;

    for (const [eventName, listener] of this.attachedListeners) {
      es.removeEventListener(eventName, listener);
    }
    this.attachedListeners.clear();

    es.onopen = null;
    es.onmessage = null;
    es.onerror = null;
    es.close();
    this.eventSource = null;
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (!this.options.autoReconnect) return;

    const maxAttempts = this.options.maxReconnectAttempts ?? 10;
    if (this.reconnectCount >= maxAttempts) {
      this.logger?.error?.('SSE max reconnect attempts reached', {
        operation: 'reconnect',
        component: 'SSEClient',
        attributes: {
          reconnectCount: this.reconnectCount,
          maxAttempts,
        },
      });
      return;
    }

    if (this.reconnectTimer) return;

    this.reconnectCount++;
    const baseInterval = this.options.reconnectIntervalMs ?? 3000;
    const maxDelayMs = this.options.maxDelayMs ?? 30000;
    const exponentialDelay = baseInterval * Math.pow(2, this.reconnectCount - 1);
    const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
    const jitter = Math.random() * cappedDelay * 0.5;
    const interval = Math.round(cappedDelay + jitter);

    this.logger?.debug?.('Scheduling SSE reconnect', {
      operation: 'reconnect',
      component: 'SSEClient',
      attributes: {
        attempt: this.reconnectCount,
        maxAttempts,
        intervalMs: interval,
      },
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || !this.url) return;

      this.closeEventSource();
      void this.openWithTicket(this.url);
    }, interval);
  }
}
