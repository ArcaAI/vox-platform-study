/**
 * The WebSocket lane of the workflow run stream (TASK-931, over TASK-930 §4).
 *
 * The SSE lane in `core/sse.ts` is the default and the only one that RESUMES. This one
 * exists for the environments where SSE does not arrive: a proxy that buffers
 * `text/event-stream` turns a live run into a stream that looks stalled and then
 * completes all at once, and no amount of `Last-Event-ID` fixes that.
 *
 * ## Zero dependencies, which decides the runtime floor
 *
 * `@arcaai/vox-node` ships no runtime dependencies, so the socket is `globalThis.WebSocket`
 * — the platform global, present in **Node 22+**, Bun, Deno and edge runtimes. On a runtime
 * without it this throws {@link SocketUnavailableError} naming that floor, rather than
 * importing a polyfill the integrator did not ask for. A silent fallback to SSE would be
 * worse than either: it would hide the proxy problem the caller switched transports to solve.
 *
 * ## Frames
 *
 * `workflow-ws.gateway.ts` sends `JSON.stringify({ event, id?, data })` — the SSE frame
 * fields, as one JSON object, with `data` already parsed into the envelope. So a consumer
 * written against the SSE lane needs no second parser, only this decode.
 */

import { SocketUnavailableError } from './errors';

/** One decoded frame from the run socket — the gateway's `{ event, id?, data }` envelope. */
export interface SocketFrame {
  /** The envelope's `type`, mirrored by the gateway into the frame's `event` field. */
  event?: string;
  /** The opaque resume cursor, mirroring the SSE `id:` line. Absent on the snapshot frame. */
  id?: string;
  /** The run event envelope itself. */
  data: unknown;
}

/** The `POST …/runs/{runId}/stream-ticket` response (TASK-930 §4, amendment A-1). */
export interface WorkflowRunStreamTicket {
  /** Single-use, ~30s, scoped to ONE run. Never a JWT — a query string is not a place for one. */
  ticket: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAt: number;
  /** Always `workflow_run:<runId>`; the gateway compares it by strict equality. */
  scope: string;
  /** Gateway-relative socket URL, `ticket` already interpolated. Resolve it with {@link resolveSocketUrl}. */
  url: string;
}

/**
 * Minimal structural view of the platform `WebSocket` — only what this module uses.
 * Structural rather than `lib.dom`'s `WebSocket`, because this package targets runtimes
 * whose lib set does not include the DOM.
 */
interface SocketLike {
  addEventListener(type: string, listener: (event: never) => void): void;
  close(code?: number): void;
}

interface SocketConstructor {
  new (url: string): SocketLike;
}

/** Strip trailing slashes and a trailing `/api/v1` — the socket route is NOT under the API prefix. */
function normalizeBase(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '');
  if (base.toLowerCase().endsWith('/api/v1')) base = base.slice(0, -'/api/v1'.length);
  return base;
}

/**
 * Turn the ticket response's `url` into an absolute `ws(s)://` URL.
 *
 * The gateway returns it gateway-relative (`/ws/workflows?slug=…&runId=…&ticket=…`), so the
 * origin comes from the client's own `baseUrl` — the one place that already knows which HOPE
 * this client talks to. An ABSOLUTE `url` is honoured as given (a deployment may terminate
 * sockets somewhere else), with only its scheme upgraded, because overriding a host the
 * gateway named would defeat the reason it named one.
 */
export function resolveSocketUrl(baseUrl: string, ticketUrl: string, lastEventId?: string): string {
  const url = new URL(ticketUrl, `${normalizeBase(baseUrl)}/`);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (lastEventId !== undefined) url.searchParams.set('lastEventId', lastEventId);
  return url.toString();
}

/** Options for {@link readSocketFrames}. */
export interface ReadSocketFramesOptions {
  signal?: AbortSignal;
}

/**
 * Open `url` and yield each frame until the server closes.
 *
 * Ends on `close`; REJECTS on `error` or an abort. That asymmetry is the point: a socket that
 * errors has not told you the run finished, and a generator that returned quietly there would
 * let `waitForRun` report a status it never received. The socket is closed on every exit path,
 * including a consumer that stops iterating early (`break`), which is what `finally` in a
 * generator is for.
 */
export async function* readSocketFrames(url: string, options: ReadSocketFramesOptions = {}): AsyncGenerator<SocketFrame, void, void> {
  const Socket = (globalThis as { WebSocket?: SocketConstructor }).WebSocket;
  if (typeof Socket !== 'function') {
    throw new SocketUnavailableError();
  }
  options.signal?.throwIfAborted();

  const socket = new Socket(url);
  const queue: SocketFrame[] = [];
  let done = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;

  const notify = (): void => {
    wake?.();
    wake = undefined;
  };

  socket.addEventListener('message', ((event: { data: unknown }) => {
    const raw = typeof event.data === 'string' ? event.data : undefined;
    if (raw === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // One unreadable frame must not destroy a stream whose remaining frames are fine —
      // and the run is unaffected by our inability to read one event. Same rule as SSE.
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    queue.push(parsed as SocketFrame);
    notify();
  }) as (event: never) => void);

  socket.addEventListener('close', (() => {
    done = true;
    notify();
  }) as (event: never) => void);

  socket.addEventListener('error', (() => {
    failure ??= new Error('The workflow run socket failed before the run reached a terminal state.');
    done = true;
    notify();
  }) as (event: never) => void);

  const onAbort = (): void => {
    failure ??= new Error('The workflow run socket was aborted by the caller.');
    done = true;
    notify();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    // Frames queued alongside the close event are still the run's answer; drain before failing.
    while (queue.length > 0) yield queue.shift()!;
    if (failure) throw failure;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    socket.close();
  }
}
