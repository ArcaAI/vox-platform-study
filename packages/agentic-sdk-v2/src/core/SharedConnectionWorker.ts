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
  authToken?: string;
  autoReconnect?: boolean;
}

export interface WSSubscription {
  url: string;
  protocols?: string[];
}

interface ManagedSSE {
  eventSource: EventSource;
  subscribers: Set<MessagePort>;
  url: string;
}

interface ManagedWS {
  socket: WebSocket;
  subscribers: Set<MessagePort>;
  url: string;
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

function handleSSESubscribe(port: MessagePort, id: string, sub: SSESubscription): void {
  const existing = sseConnections.get(id);
  if (existing) {
    existing.subscribers.add(port);
    port.postMessage({ type: 'connection_count', id, payload: { count: existing.subscribers.size } });
    return;
  }

  let url = sub.url;
  if (sub.authToken) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}token=${encodeURIComponent(sub.authToken)}`;
  }

  const es = new EventSource(url);
  const managed: ManagedSSE = {
    eventSource: es,
    subscribers: new Set([port]),
    url: sub.url,
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

  sseConnections.set(id, managed);
  port.postMessage({ type: 'connection_count', id, payload: { count: 1 } });
}

function handleSSEUnsubscribe(port: MessagePort, id: string): void {
  const managed = sseConnections.get(id);
  if (!managed) return;

  managed.subscribers.delete(port);

  if (managed.subscribers.size === 0) {
    managed.eventSource.close();
    sseConnections.delete(id);
  }
}

function handleWSSubscribe(port: MessagePort, id: string, sub: WSSubscription): void {
  const existing = wsConnections.get(id);
  if (existing) {
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
    wsConnections.delete(id);
  };

  ws.onerror = () => {
    broadcastToSubscribers(managed.subscribers, { type: 'ws_error', id });
  };

  wsConnections.set(id, managed);
  port.postMessage({ type: 'connection_count', id, payload: { count: 1 } });
}

function handleWSUnsubscribe(port: MessagePort, id: string): void {
  const managed = wsConnections.get(id);
  if (!managed) return;

  managed.subscribers.delete(port);

  if (managed.subscribers.size === 0) {
    managed.socket.close(1000, 'All tabs unsubscribed');
    wsConnections.delete(id);
  }
}

function handleWSSend(id: string, data: unknown): void {
  const managed = wsConnections.get(id);
  if (!managed || managed.socket.readyState !== WebSocket.OPEN) return;

  if (typeof data === 'string') {
    managed.socket.send(data);
  } else if (data instanceof ArrayBuffer || data instanceof Blob) {
    managed.socket.send(data as ArrayBuffer | Blob);
  } else {
    managed.socket.send(JSON.stringify(data));
  }
}

function handlePortDisconnect(port: MessagePort): void {
  allPorts.delete(port);

  for (const [id, managed] of sseConnections) {
    managed.subscribers.delete(port);
    if (managed.subscribers.size === 0) {
      managed.eventSource.close();
      sseConnections.delete(id);
    }
  }

  for (const [id, managed] of wsConnections) {
    managed.subscribers.delete(port);
    if (managed.subscribers.size === 0) {
      managed.socket.close(1000, 'All tabs disconnected');
      wsConnections.delete(id);
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
      if (msg.id) handleSSEUnsubscribe(port, msg.id);
      break;
    case 'subscribe_ws':
      if (msg.id && msg.payload) handleWSSubscribe(port, msg.id, msg.payload as WSSubscription);
      break;
    case 'unsubscribe_ws':
      if (msg.id) handleWSUnsubscribe(port, msg.id);
      break;
    case 'ws_send':
      if (msg.id) handleWSSend(msg.id, msg.payload);
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
