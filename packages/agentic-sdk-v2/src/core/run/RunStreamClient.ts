/**
 * @arcaai/vox — the run follow engine (TASK-1039).
 *
 * One function, {@link followRun}, turns "a way to open a connection" (a {@link RunConnector}) into
 * an ordered, resumable stream of protocol-v2 events:
 *
 * - **Decodes** every frame through the normaliser, so a gateway that still sends the legacy
 *   workflow frames looks the same as one that sends v2.
 * - **Resumes by `seq`.** A dropped connection is re-opened with the last `seq` it saw; replayed
 *   events are dropped (`advanceRunCursor`). It NEVER infers loss from a jump in `seq` — the public
 *   plane is filtered out of one stored sequence, so jumps are normal. Only the server signals
 *   loss, with `run.resync`, and that is handed to the caller (`reset: true`) to apply.
 * - **Never cancels.** A run is a durable execution; aborting the signal or losing the connection
 *   only ends THIS view. There is no cancel anywhere in this module.
 *
 * Two connectors ship, because the two ways a browser can authenticate a stream differ:
 *
 * - {@link createEventSourceConnector} — `EventSource` + a run-scoped, single-use stream ticket
 *   (`POST …/runs/:runId/stream-ticket`). The ticket is the credential, so it works for an
 *   API-key app that holds no JWT. A fresh ticket is minted for EVERY connect.
 * - {@link createFetchConnector} — a `fetch` stream that carries the client's own headers
 *   (`Authorization` / `X-API-Key`). Used where the gateway mints no run-scoped ticket (agent
 *   runs): `EventSource` cannot set headers, `fetch` can.
 */

import { RunFrameNormaliser } from './run-normaliser';
import {
  ADMIN_RUN_EVENT_TYPES,
  PUBLIC_RUN_EVENT_TYPES,
  RUN_PROTOCOL_HEADER,
  RUN_PROTOCOL_VERSION,
  advanceRunCursor,
  isTerminalRunEventType,
  isTerminalRunStatusValue,
  type RunEventV2,
} from './run-protocol';
import { parseSseStream } from './sse';

/** One SSE frame as a connector hands it over. */
export interface RawRunFrame {
  event?: string;
  data: string;
  id?: string;
}

/** What a connector is asked to resume from. At most one of the two is set. */
export interface RunCursor {
  /** Protocol v2: the last `seq` seen. */
  after: number | undefined;
  /** Legacy frames: the opaque `id` of the last frame seen. */
  legacyId: string | undefined;
}

export interface RunConnectorRequest extends RunCursor {
  /** Aborts THIS connection only. */
  signal: AbortSignal;
  onFrame: (frame: RawRunFrame) => void;
}

/**
 * Open ONE connection and push its frames to `onFrame`. Resolve when the connection ends (cleanly
 * or not — the engine decides from the events whether the run ended). Reject with
 * {@link RunStreamHttpError} for an HTTP-level refusal, or any network error.
 */
export type RunConnector = (request: RunConnectorRequest) => Promise<void>;

/** The stream could not be opened or kept open; `status` `0` means no HTTP status is known (an `EventSource` that never opened). */
export class RunStreamHttpError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? (status === 0 ? 'The run stream could not be opened.' : `The run stream answered HTTP ${status}.`));
    this.name = 'RunStreamHttpError';
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The stream could not be re-established within the reconnect budget. The RUN is unaffected — attach again with `after: lastSeq`. */
export class RunStreamInterruptedError extends Error {
  readonly runId: string;
  readonly lastSeq: number;
  readonly cause?: unknown;

  constructor(options: { runId: string; lastSeq: number; cause?: unknown }) {
    super(`The event stream of run ${options.runId} could not be re-established (last seq ${options.lastSeq}). The run itself is unaffected.`);
    this.name = 'RunStreamInterruptedError';
    this.cause = options.cause;
    this.runId = options.runId;
    this.lastSeq = options.lastSeq;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface FollowRunOptions {
  runId: string;
  connector: RunConnector;
  /**
   * Called for every event the caller should apply, in order. `reset` is `true` for `run.resync`: replace your state with `event.data.snapshot`.
   * `protocol` is the wire shape the event came from; a `legacy` event's `seq` is synthetic and is NOT a resume cursor.
   */
  onEvent: (event: RunEventV2, info: { reset: boolean; protocol: 2 | 'legacy' }) => void;
  /** Resume after this `seq` — one a previous mount persisted. Omit to replay the retained window from the start. */
  after?: number;
  /** Stops following. Never cancels the run. */
  signal?: AbortSignal;
  /**
   * Reconnects that may be spent WITHOUT receiving a single frame before giving up with
   * {@link RunStreamInterruptedError}. A connection that delivers anything resets the count. Default `5`.
   */
  maxReconnects?: number;
  /** First reconnect delay in ms; doubles per consecutive failure, capped at 5 s. Default `250`; `0` reconnects immediately. */
  reconnectDelayMs?: number;
  /** Called with the highest cursor reached after each connection's frames — what a caller persists to resume later. */
  onCursor?: (seq: number) => void;
}

const DEFAULT_MAX_RECONNECTS = 5;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** A reconnect can cure a dropped socket, a 5xx, a 408 or a 429 — not a 404 (not yours / not there) or a 400 (bad cursor). */
function isTransient(error: unknown): boolean {
  const status =
    error instanceof RunStreamHttpError
      ? error.status
      : ((error as { context?: { status?: unknown } } | null)?.context?.status as number | undefined);
  if (typeof status === 'number') return status === 0 || status >= 500 || status === 408 || status === 429;
  if ((error as { code?: unknown } | null)?.code === 'NETWORK_ERROR') return true;
  return error instanceof TypeError;
}

/**
 * Follow a run until its terminal event (or until `signal` aborts). Resolves `'terminal'` or
 * `'aborted'`; rejects with {@link RunStreamInterruptedError} when the stream cannot be
 * re-established, or with the connector's own error when a reconnect could not cure it.
 */
export async function followRun(options: FollowRunOptions): Promise<'terminal' | 'aborted'> {
  const { signal } = options;
  const normaliser = new RunFrameNormaliser(options.runId);
  const budget = options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
  const baseDelay = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  let cursor = options.after ?? 0;
  let hasCursor = options.after !== undefined;
  let legacyId: string | undefined;
  let sawLegacy = false;
  let failures = 0;
  let lastError: unknown;

  for (;;) {
    if (signal?.aborted) return 'aborted';

    const connection = new AbortController();
    const abortConnection = (): void => connection.abort();
    signal?.addEventListener('abort', abortConnection, { once: true });
    let progressed = false;
    let terminal = false;

    const onFrame = (frame: RawRunFrame): void => {
      if (terminal) return;
      progressed = true;
      const normalised = normaliser.normalise(frame);
      if (normalised.protocol === 'legacy' && frame.id !== undefined && frame.id !== '') {
        legacyId = frame.id;
        sawLegacy = true;
      }
      for (const event of normalised.events) {
        let reset = false;
        if (normalised.protocol === 2) {
          const step = advanceRunCursor(cursor, event);
          cursor = step.cursor;
          hasCursor = true;
          reset = step.reset;
          if (!step.deliver) continue;
        }
        options.onEvent(event, { reset, protocol: normalised.protocol === 'legacy' ? 'legacy' : 2 });
        if (isTerminalRunEventType(event.type) || (event.type === 'run.resync' && isTerminalRunStatusValue(event.data.snapshot.status))) {
          terminal = true;
          connection.abort();
          break;
        }
      }
      if (hasCursor) options.onCursor?.(cursor);
    };

    try {
      await options.connector({ after: hasCursor && !sawLegacy ? cursor : undefined, legacyId, signal: connection.signal, onFrame });
    } catch (error) {
      if (!terminal && !signal?.aborted) {
        if (!isTransient(error)) throw error;
        lastError = error;
      }
    } finally {
      signal?.removeEventListener('abort', abortConnection);
    }

    if (terminal) return 'terminal';
    if (signal?.aborted) return 'aborted';

    // The connection ended and the run did not: that is a drop, whether it closed cleanly or reset.
    failures = progressed ? 0 : failures + 1;
    if (failures > budget) throw new RunStreamInterruptedError({ runId: options.runId, lastSeq: cursor, cause: lastError });
    if (!progressed && baseDelay > 0) await sleep(Math.min(baseDelay * 2 ** (failures - 1), MAX_RECONNECT_DELAY_MS), signal);
  }
}

// ------------------------------------------------------------------------------------------------
// Connectors
// ------------------------------------------------------------------------------------------------

/** The SSE event names an `EventSource` has to subscribe to by name: protocol v2, then the legacy workflow frames. */
const FRAME_EVENT_NAMES: readonly string[] = Object.freeze([
  ...PUBLIC_RUN_EVENT_TYPES,
  ...ADMIN_RUN_EVENT_TYPES,
  'workflow.run.progress',
  'workflow.run.completed',
  'workflow.node.started',
  'workflow.node.completed',
  'workflow.node.failed',
  'workflow.loop.iteration',
  'workflow.guardrail.verdict',
  'workflow.token.delta',
]);

/**
 * `EventSource` + a fresh run-scoped ticket per connect. `buildUrl` mints the ticket and returns
 * the ABSOLUTE stream URL with the ticket and the resume cursor already on it (`EventSource`
 * cannot set `Last-Event-ID` on a connection this client opens itself).
 *
 * `EventSource` reports a refused connection and a dropped one the same way (`error`), so a stream
 * that never opened is thrown as `RunStreamHttpError(0)` — transient, spent against the budget —
 * and one that had opened simply ends, which the engine treats as a drop.
 */
export function createEventSourceConnector(buildUrl: (cursor: RunCursor) => Promise<string>): RunConnector {
  return async ({ after, legacyId, signal, onFrame }) => {
    const url = await buildUrl({ after, legacyId });
    if (signal.aborted) return;
    if (typeof EventSource === 'undefined') throw new Error('`EventSource` is not available in this runtime.');

    await new Promise<void>((resolve, reject) => {
      const source = new EventSource(url);
      let opened = false;
      const finish = (error?: Error): void => {
        signal.removeEventListener('abort', onAbort);
        source.close();
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => finish();
      const deliver = (event: Event): void => {
        const message = event as MessageEvent<string>;
        onFrame({ event: message.type, data: message.data, id: message.lastEventId === '' ? undefined : message.lastEventId });
      };
      source.onopen = () => {
        opened = true;
      };
      source.onmessage = deliver;
      for (const name of FRAME_EVENT_NAMES) source.addEventListener(name, deliver);
      source.onerror = () => finish(opened ? undefined : new RunStreamHttpError(0));
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
}

/**
 * A header-authenticated `fetch` stream. `open` performs the request (the client adds its own
 * credentials) and must answer the `Response`, rejecting on a non-2xx.
 */
export function createFetchConnector(open: (request: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>): RunConnector {
  return async ({ after, legacyId, signal, onFrame }) => {
    const cursor = after !== undefined ? String(after) : legacyId;
    let response: Response;
    try {
      response = await open({
        headers: {
          Accept: 'text/event-stream',
          [RUN_PROTOCOL_HEADER]: String(RUN_PROTOCOL_VERSION),
          // Omitted on a first connect: an empty header would name a cursor the gateway cannot resolve.
          ...(cursor === undefined || cursor === '0' ? {} : { 'Last-Event-ID': cursor }),
        },
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    if (!response.body) return;
    try {
      for await (const frame of parseSseStream(response.body, { signal })) onFrame(frame);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  };
}
