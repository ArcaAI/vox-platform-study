/**
 * @arcaai/vox - SharedConnectionWorker
 *
 * SharedWorker script for managing WebSocket and SSE connections across
 * browser tabs. Prevents connection multiplication when users open
 * multiple tabs with the same consultation.
 *
 * Architecture:
 *   - One SharedWorker instance per origin
 *   - Each tab connects via a MessagePort
 *   - The worker maintains a single WebSocket/SSE per unique endpoint
 *   - Messages are broadcast to all subscribed tabs
 *   - Automatic cleanup when tabs disconnect
 *
 * This file is the worker entry point — it runs in a separate thread.
 * Use SharedConnectionManager (client-side) to interact with it.
 */

export interface WorkerMessage {
  type: WorkerMessageType;
  id?: string;
  payload?: unknown;
}

export type WorkerMessageType =
  | 'subscribe_sse'
  | 'unsubscribe_sse'
  | 'subscribe_ws'
  | 'unsubscribe_ws'
  | 'ws_send'
  | 'sse_event'
  | 'ws_message'
  | 'ws_open'
  | 'ws_close'
  | 'ws_error'
  | 'sse_open'
  | 'sse_error'
  | 'connection_count'
  | 'ping'
  | 'pong'
  | 'tab_count';

export interface SSESubscription {
  url: string;
  /**
   * Short-lived stream ticket minted by the API via
   * `POST /auth/stream-ticket`. Passed as `?ticket=<…>` on the SSE URL.
   *
   * A raw JWT must never be embedded in the URL instead, since that would:
   *   - leak the JWT into webserver / proxy access logs,
   *   - leak it into `Referer` headers if the SSE backend ever redirected,
   *   - persist it in browser history / DevTools network panel.
   */
  ticket?: string;
  /**
   * Owner user id (the user that minted the ticket).
   * SSE deduplication keys on `(id, userId)` so we never share an
   * upstream connection across distinct user contexts.
   */
  userId?: string;
  autoReconnect?: boolean;
}

export interface WSSubscription {
  url: string;
  protocols?: string[];
  /**
   * Owner user id. WebSocket deduplication keys on
   * `(id, userId)` (see `wsDedupKey`) so we never share one upstream socket
   * across distinct user contexts even when the base id collides — mirrors
   * the SSE `(id, userId)` dedup.
   */
  userId?: string;
  /**
   * Active tenant id, carried alongside `userId` for
   * diagnostics / defense-in-depth. The dedup key itself is `(id, userId)`;
   * `tenantId` travels with the subscription so a future cross-tenant guard
   * has the discriminator without another round-trip.
   */
  tenantId?: string;
}

interface ManagedSSE {
  eventSource: EventSource;
  subscribers: Set<MessagePort>;
  url: string;
  /** Owner user id for the upstream connection. */
  userId?: string;
}

interface ManagedWS {
  socket: WebSocket;
  subscribers: Set<MessagePort>;
  url: string;
  /** Owner user id for the upstream connection. */
  userId?: string;
}

const sseConnections = new Map<string, ManagedSSE>();
const wsConnections = new Map<string, ManagedWS>();
const allPorts = new Set<MessagePort>();

function broadcastToSubscribers(subscribers: Set<MessagePort>, message: WorkerMessage): void {
  for (const port of subscribers) {
    try {
      port.postMessage(message);
    } catch {
      subscribers.delete(port);
    }
  }
}

function broadcastToAll(message: WorkerMessage): void {
  for (const port of allPorts) {
    try {
      port.postMessage(message);
    } catch {
      allPorts.delete(port);
    }
  }
}

/**
 * Compose the SSE dedup key from `(id, userId)`.
 * Two tabs may share an upstream EventSource only when both their ids
 * and their owner user ids match.
 */
function sseDedupKey(id: string, userId: string | undefined): string {
  return `${id}::${userId ?? 'anon'}`;
}

/**
 * Compose the WebSocket dedup key from `(id, userId)`,
 * symmetric to `sseDedupKey`. Two tabs may share an upstream WebSocket only
 * when both their ids and their owner user ids match; distinct users that
 * collide on `id` get distinct sockets and never cross-wire each other's
 * audio / transcript stream.
 */
function wsDedupKey(id: string, userId: string | undefined): string {
  return `${id}::${userId ?? 'anon'}`;
}

function handleSSESubscribe(port: MessagePort, id: string, sub: SSESubscription): void {
  const dedupKey = sseDedupKey(id, sub.userId);
  const existing = sseConnections.get(dedupKey);
  if (existing) {
    // Refuse to share when user id mismatches.
    if (existing.userId !== sub.userId) {
      port.postMessage({
        type: 'sse_error',
        id,
        payload: { reason: 'USER_MISMATCH', expected: existing.userId, got: sub.userId },
      });
      return;
    }
    existing.subscribers.add(port);
    port.postMessage({ type: 'connection_count', id, payload: { count: existing.subscribers.size } });
    return;
  }

  // Append a stream ticket (NOT a JWT) when provided.
  let url = sub.url;
  if (sub.ticket) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}ticket=${encodeURIComponent(sub.ticket)}`;
  }

  const es = new EventSource(url);
  const managed: ManagedSSE = {
    eventSource: es,
    subscribers: new Set([port]),
    url: sub.url,
    userId: sub.userId,
  };

  es.onopen = () => {
    broadcastToSubscribers(managed.subscribers, { type: 'sse_open', id });
  };

  es.onmessage = (event: MessageEvent) => {
    broadcastToSubscribers(managed.subscribers, {
      type: 'sse_event',
      id,
      payload: { event: 'message', data: event.data },
    });
  };

  es.onerror = () => {
    broadcastToSubscribers(managed.subscribers, { type: 'sse_error', id });
  };

  const namedEvents = ['status', 'progress', 'result', 'transcript', 'error', 'complete'];
  for (const eventName of namedEvents) {
    es.addEventListener(eventName, (event: Event) => {
      const me = event as MessageEvent;
      broadcastToSubscribers(managed.subscribers, {
        type: 'sse_event',
        id,
        payload: { event: eventName, data: me.data },
      });
    });
  }

  sseConnections.set(dedupKey, managed);
  port.postMessage({ type: 'connection_count', id, payload: { count: 1 } });
}

function handleSSEUnsubscribe(port: MessagePort, id: string, userId?: string): void {
  // Caller may supply userId; if absent, scan every
  // entry sharing the base id and remove the port from each.
  if (userId !== undefined) {
    const dedupKey = sseDedupKey(id, userId);
    const managed = sseConnections.get(dedupKey);
    if (!managed) return;
    managed.subscribers.delete(port);
    if (managed.subscribers.size === 0) {
      managed.eventSource.close();
      sseConnections.delete(dedupKey);
    }
    return;
  }
  const matchPrefix = `${id}::`;
  for (const [key, managed] of sseConnections) {
    if (!key.startsWith(matchPrefix)) continue;
    managed.subscribers.delete(port);
    if (managed.subscribers.size === 0) {
      managed.eventSource.close();
      sseConnections.delete(key);
    }
  }
}

function handleWSSubscribe(port: MessagePort, id: string, sub: WSSubscription): void {
  // Dedup on `(id, userId)`, not the bare id.
  const dedupKey = wsDedupKey(id, sub.userId);
  const existing = wsConnections.get(dedupKey);
  if (existing) {
    // Refuse to share when the user id mismatches
    // (mirrors the SSE dedup guard). With a `(id, userId)` key this is a
    // defense-in-depth invariant: a shared slot always has one owner user.
    if (existing.userId !== sub.userId) {
      port.postMessage({
        type: 'ws_error',
        id,
        payload: { reason: 'USER_MISMATCH', expected: existing.userId, got: sub.userId },
      });
      return;
    }
    existing.subscribers.add(port);
    if (existing.socket.readyState === WebSocket.OPEN) {
      port.postMessage({ type: 'ws_open', id });
    }
    port.postMessage({ type: 'connection_count', id, payload: { count: existing.subscribers.size } });
    return;
  }

  const ws = new WebSocket(sub.url, sub.protocols);
  const managed: ManagedWS = {
    socket: ws,
    subscribers: new Set([port]),
    url: sub.url,
    userId: sub.userId,
  };

  ws.onopen = () => {
    broadcastToSubscribers(managed.subscribers, { type: 'ws_open', id });
  };

  ws.onmessage = (event: MessageEvent) => {
    broadcastToSubscribers(managed.subscribers, {
      type: 'ws_message',
      id,
      payload: event.data,
    });
  };

  ws.onclose = (event: CloseEvent) => {
    broadcastToSubscribers(managed.subscribers, {
      type: 'ws_close',
      id,
      payload: { code: event.code, reason: event.reason },
    });
    wsConnections.delete(dedupKey);
  };

  ws.onerror = () => {
    broadcastToSubscribers(managed.subscribers, { type: 'ws_error', id });
  };

  wsConnections.set(dedupKey, managed);
  port.postMessage({ type: 'connection_count', id, payload: { count: 1 } });
}

function handleWSUnsubscribe(port: MessagePort, id: string, userId?: string): void {
  // Caller may supply userId; if absent, scan every
  // entry sharing the base id and remove the port from each (mirrors SSE).
  if (userId !== undefined) {
    const dedupKey = wsDedupKey(id, userId);
    const managed = wsConnections.get(dedupKey);
    if (!managed) return;
    managed.subscribers.delete(port);
    if (managed.subscribers.size === 0) {
      managed.socket.close(1000, 'All tabs unsubscribed');
      wsConnections.delete(dedupKey);
    }
    return;
  }
  const matchPrefix = `${id}::`;
  for (const [key, managed] of wsConnections) {
    if (!key.startsWith(matchPrefix)) continue;
    managed.subscribers.delete(port);
    if (managed.subscribers.size === 0) {
      managed.socket.close(1000, 'All tabs unsubscribed');
      wsConnections.delete(key);
    }
  }
}

function handleWSSend(port: MessagePort, id: string, data: unknown): void {
  // Multiple users may share a base id, so route the
  // send to the socket the SENDER port is subscribed to. This fail-closes a
  // cross-user send leak: a tab can only write to its own user's socket.
  const matchPrefix = `${id}::`;
  for (const [key, managed] of wsConnections) {
    if (!key.startsWith(matchPrefix)) continue;
    if (!managed.subscribers.has(port)) continue;
    if (managed.socket.readyState !== WebSocket.OPEN) continue;

    if (typeof data === 'string') {
      managed.socket.send(data);
    } else if (data instanceof ArrayBuffer || data instanceof Blob) {
      managed.socket.send(data as ArrayBuffer | Blob);
    } else {
      managed.socket.send(JSON.stringify(data));
    }
    return;
  }
}

function handlePortDisconnect(port: MessagePort): void {
  allPorts.delete(port);

  for (const [dedupKey, managed] of sseConnections) {
    managed.subscribers.delete(port);
    if (managed.subscribers.size === 0) {
      managed.eventSource.close();
      sseConnections.delete(dedupKey);
    }
  }

  for (const [dedupKey, managed] of wsConnections) {
    managed.subscribers.delete(port);
    if (managed.subscribers.size === 0) {
      managed.socket.close(1000, 'All tabs disconnected');
      wsConnections.delete(dedupKey);
    }
  }

  broadcastToAll({ type: 'tab_count', payload: { count: allPorts.size } });
}

function handleMessage(port: MessagePort, msg: WorkerMessage): void {
  switch (msg.type) {
    case 'subscribe_sse':
      if (msg.id && msg.payload) handleSSESubscribe(port, msg.id, msg.payload as SSESubscription);
      break;
    case 'unsubscribe_sse':
      if (msg.id) {
        const u =
          msg.payload && typeof msg.payload === 'object' && 'userId' in msg.payload
            ? ((msg.payload as { userId?: string }).userId ?? undefined)
            : undefined;
        handleSSEUnsubscribe(port, msg.id, u);
      }
      break;
    case 'subscribe_ws':
      if (msg.id && msg.payload) handleWSSubscribe(port, msg.id, msg.payload as WSSubscription);
      break;
    case 'unsubscribe_ws':
      if (msg.id) {
        const u =
          msg.payload && typeof msg.payload === 'object' && 'userId' in msg.payload
            ? ((msg.payload as { userId?: string }).userId ?? undefined)
            : undefined;
        handleWSUnsubscribe(port, msg.id, u);
      }
      break;
    case 'ws_send':
      if (msg.id) handleWSSend(port, msg.id, msg.payload);
      break;
    case 'ping':
      port.postMessage({ type: 'pong' });
      break;
    default:
      break;
  }
}

/**
 * SharedWorker entry point.
 * In a SharedWorker context, `self` is a SharedWorkerGlobalScope.
 * The type is declared inline since the WebWorker lib may not be included.
 */
interface SharedWorkerGlobalScopeCompat {
  onconnect: ((event: MessageEvent) => void) | null;
}
declare const self: SharedWorkerGlobalScopeCompat;

self.onconnect = (event: MessageEvent) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ConnectEvent.ports not in lib.dom MessageEvent typing.
  const port = (event as any).ports[0] as MessagePort;
  allPorts.add(port);

  port.onmessage = (e: MessageEvent) => {
    handleMessage(port, e.data as WorkerMessage);
  };

  port.onmessageerror = () => {
    handlePortDisconnect(port);
  };

  port.postMessage({ type: 'tab_count', payload: { count: allPorts.size } });
  port.start();
};

// ---------------------------------------------------------------------------
// Test-only surface.
//
// In jsdom the SharedWorker `self.onconnect` lifecycle never fires, so the
// dedup logic is otherwise unreachable from a unit test. These thin hooks let
// tests drive the real `handleMessage` dispatcher and reset module state
// between cases. They are intentionally not part of the public SDK surface and
// must not be imported by production code.
// ---------------------------------------------------------------------------
export function __handleMessageForTests(port: MessagePort, msg: WorkerMessage): void {
  handleMessage(port, msg);
}

export function __resetConnectionsForTests(): void {
  for (const managed of wsConnections.values()) {
    try {
      managed.socket.close();
    } catch {
      /* noop — best-effort teardown in tests */
    }
  }
  wsConnections.clear();
  for (const managed of sseConnections.values()) {
    try {
      managed.eventSource.close();
    } catch {
      /* noop — best-effort teardown in tests */
    }
  }
  sseConnections.clear();
  allPorts.clear();
}
