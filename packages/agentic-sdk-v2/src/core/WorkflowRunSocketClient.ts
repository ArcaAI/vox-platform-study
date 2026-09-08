/**
 * @arcaai/vox — the WebSocket lane of a workflow run stream (TASK-931, over TASK-930 §4).
 *
 * `SSEClient` is the default lane and the only one that RESUMES: it re-mints a ticket per
 * connect and replays with `Last-Event-ID`, so a dropped connection costs latency, never
 * frames. This one exists for the deployments where SSE does not arrive at all — a proxy that
 * buffers `text/event-stream` turns a live run into a stream that looks stalled and then
 * completes all at once, and no amount of resume fixes that.
 *
 * Same authentication story as SSE, and for the same reason: a single-use, run-scoped ticket
 * minted over an ordinary POST, never a JWT in the query string. The difference is only WHICH
 * route mints it — `POST /workflows/{slug}/runs/{runId}/stream-ticket`, which binds the ticket
 * to one run at mint time and answers the socket URL to open.
 *
 * Shaped like `SSEClient` on purpose (`connect` / `disconnect` / `getLastEventId`), so
 * `useWorkflowRun` picks a lane rather than branching through its whole watch path.
 */

import type { ISDKLogger } from './logger';

/** The subset of the API client this needs — one POST, to mint the ticket. */
export interface SocketApiClient {
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  getBaseUrl(): string;
}

/** The `POST …/runs/{runId}/stream-ticket` response (TASK-930 §4, amendment A-1). */
export interface WorkflowRunStreamTicket {
  /** Single-use, ~30s-lived, scoped to ONE run. */
  ticket: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAt: number;
  /** Always `workflow_run:<runId>` — the gateway compares it by strict equality. */
  scope: string;
  /** Gateway-relative socket URL with the ticket already interpolated. */
  url: string;
}

/**
 * Thrown when the socket lane is asked for on a runtime with no `WebSocket`.
 *
 * Practically unreachable in a browser, and deliberately kept anyway: this SDK also runs
 * under jsdom and in test environments that stub globals, and "the transport you asked for is
 * not available here" is a better answer than a `TypeError` from a missing constructor. Never
 * a silent fallback to SSE — `socket` is chosen for a reason, and quietly serving the lane the
 * caller ruled out would reproduce the symptom they switched away from.
 */
export class SocketUnavailableError extends Error {
  constructor() {
    super(
      "`transport: 'socket'` needs a `WebSocket` global, and this runtime has none. Use the default SSE lane " +
        "(`transport: 'sse'`), which is also the only lane that resumes with `Last-Event-ID`.",
    );
    this.name = 'SocketUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** One frame as the gateway sends it: the SSE fields, as one JSON object. */
interface SocketFrame {
  event?: string;
  id?: string;
  data?: unknown;
}

/** Strip trailing slashes and a trailing `/api/v1` — the socket route is NOT under the API prefix. */
function normalizeBase(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '');
  if (base.toLowerCase().endsWith('/api/v1')) base = base.slice(0, -'/api/v1'.length);
  return base;
}

/**
 * Resolve the ticket's `url` against the client's base and upgrade the scheme.
 *
 * An ABSOLUTE url is honoured as given (a deployment may terminate sockets elsewhere) with
 * only its scheme upgraded — overriding a host the gateway named would defeat the reason it
 * named one.
 */
export function resolveWorkflowSocketUrl(baseUrl: string, ticketUrl: string, lastEventId?: string): string {
  const url = new URL(ticketUrl, `${normalizeBase(baseUrl)}/`);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (lastEventId !== undefined) url.searchParams.set('lastEventId', lastEventId);
  return url.toString();
}

/** `POST` path of the run-scoped ticket route. */
export function workflowRunStreamTicketPath(slug: string, runId: string): string {
  return `/workflows/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}/stream-ticket`;
}

/** Watch ONE run's events over a WebSocket. One instance per watch; not reusable after `disconnect()`. */
export class WorkflowRunSocketClient {
  private socket: WebSocket | null = null;
  private lastEventId: string | null = null;
  private disposed = false;
  private frameHandler: ((envelope: Record<string, unknown>, cursor: string | null) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;

  constructor(
    private readonly slug: string,
    private readonly runId: string,
    private readonly api: SocketApiClient,
    private readonly logger?: ISDKLogger,
  ) {}

  /** Every decoded frame, with the cursor (`id`) that frame carried — `null` for the snapshot, which has none. */
  onFrame(cb: (envelope: Record<string, unknown>, cursor: string | null) => void): void {
    this.frameHandler = cb;
  }

  /** A mint failure or a socket error. The run is unaffected; only this VIEW of it ended. */
  onError(cb: (error: Error) => void): void {
    this.errorHandler = cb;
  }

  /** The opaque resume cursor last seen, or `null`. */
  getLastEventId(): string | null {
    return this.lastEventId;
  }

  /**
   * Mint a ticket and open the socket.
   *
   * Synchronous like `SSEClient.connect`, so the two lanes are interchangeable at the call
   * site; the mint is a promise handled internally, and a failure reaches {@link onError}
   * rather than an unhandled rejection. The `WebSocket` check happens FIRST and throws
   * synchronously — a single-use ticket spent on a runtime that cannot open a socket is
   * a ticket wasted.
   */
  connect(lastEventId?: string): void {
    if (typeof WebSocket !== 'function') throw new SocketUnavailableError();
    this.lastEventId = lastEventId ?? null;
    void this.open(lastEventId);
  }

  private async open(lastEventId?: string): Promise<void> {
    let url: string;
    try {
      const ticket = await this.api.post<WorkflowRunStreamTicket>(workflowRunStreamTicketPath(this.slug, this.runId));
      url = resolveWorkflowSocketUrl(this.api.getBaseUrl(), ticket.url, lastEventId);
    } catch (cause) {
      this.fail(cause, 'workflow run socket: could not mint a stream ticket');
      return;
    }
    // `disconnect()` may have been called while the mint was in flight — opening now would
    // leak a socket nobody holds a handle to.
    if (this.disposed) return;

    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('message', (event: MessageEvent) => this.handleMessage(event));
    socket.addEventListener('error', () => this.fail(undefined, 'workflow run socket: the connection failed'));
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') return;
    let frame: SocketFrame;
    try {
      frame = JSON.parse(event.data) as SocketFrame;
    } catch {
      // One unreadable frame must not tear down a stream whose remaining frames are fine —
      // the run is unaffected either way. The same rule the SSE lane follows.
      return;
    }
    if (typeof frame.data !== 'object' || frame.data === null) return;
    // Advance the cursor ONLY for a frame that carried one: the snapshot frame has no `id` by
    // design, and treating its absence as "reset" would re-deliver the window on every resume.
    if (typeof frame.id === 'string') this.lastEventId = frame.id;
    this.frameHandler?.(frame.data as Record<string, unknown>, this.lastEventId);
  }

  private fail(cause: unknown, message: string): void {
    const error = cause instanceof Error ? cause : new Error(message);
    this.logger?.warn?.(`${message} (${this.slug}/${this.runId}): ${error.message}`);
    this.errorHandler?.(error);
  }

  /** Close the socket. NEVER cancels the run — a durable execution outlives your view of it. */
  disconnect(): void {
    this.disposed = true;
    this.socket?.close();
    this.socket = null;
  }
}
