/**
 * `RunHandle` — one handle for one run, workflow or agent (TASK-1039 R1).
 *
 * ```ts
 * const hope = new HopeClient({ baseUrl: process.env.HOPE_API_URL!, apiKey: process.env.HOPE_API_KEY! });
 *
 * // 1. Run and stream the text as it is written.
 * const run = await hope.workflows.run('note-writer', { note }, { idempotencyKey: `note-${visitId}` });
 * for await (const chunk of run.text()) process.stdout.write(chunk);
 * const note = await run.result();              // the delivered value, verified
 *
 * // 2. Start now, poll until done (no stream — behind a proxy that buffers SSE, or in a cron job).
 * const outcome = await run.wait({ poll: true, intervalMs: 2_000 });
 * if (outcome.status !== 'COMPLETED') console.error(outcome.error?.code);
 *
 * // 3. Cancel. Idempotent; disconnecting or breaking out of a loop NEVER does this for you.
 * await run.cancel();
 *
 * // 4. Another process, later: pick the run up by id.
 * const same = hope.workflows.attach('note-writer', run.runId);
 * for await (const event of same.events({ after: persistedSeq })) { … }
 * ```
 *
 * ## What the handle does so you do not
 *
 * - **Speaks protocol v2 and hides it.** Frames are decoded by the normaliser
 *   (`core/run-normaliser.ts`), which for one release also maps the legacy workflow frame shapes
 *   onto v2 events, so the same code runs against a gateway that has not shipped v2.
 * - **Resumes by `seq`.** A dropped connection reconnects with `Last-Event-ID: <seq>` and replayed
 *   events are dropped. It NEVER infers loss from a jump in `seq` — the public plane is filtered
 *   out of one stored sequence, so jumps are normal; only the server signals loss, with
 *   `run.resync`, and the handle applies it.
 * - **Never cancels on disconnect.** A run is a durable execution. Breaking out of a `for await`,
 *   aborting a signal, or a stream that cannot be re-established only ends YOUR view of it.
 * - **Hides tickets.** The SSE lane needs none; credentials travel as headers.
 *
 * Every iterator (`events()`, `text()`, `wait()`) is an independent connection that replays from
 * its own cursor, so they can be used in any combination. They share one view of the run's state,
 * which is what `status`, `lastSeq` and `cancel()` read.
 */

import { APIConnectionError, HopeAPIError, RunFailedError, RunResultIntegrityError, RunStreamInterruptedError } from './errors';
import { RunFrameNormaliser } from './run-normaliser';
import {
  RUN_PROTOCOL_HEADER,
  RUN_PROTOCOL_VERSION,
  type PublicRunEventType,
  type RunError,
  type RunEventV2,
  type RunResult,
  type RunStatus,
  type RunTokens,
  advanceRunCursor,
  isTerminalRunEventType,
  isTerminalRunStatusValue,
} from './run-protocol';
import { parseSseStream } from './sse';
import type { Transport } from './transport';
import { encodePathSegment } from './url';

/** An event a business-plane run stream delivers. Narrow on `type` for the typed `data`. */
export type RunEvent = RunEventV2<PublicRunEventType>;

/** What a finished run looked like, as far as the handle could see. */
export interface RunOutcome {
  readonly runId: string;
  readonly status: RunStatus;
  readonly durationMs?: number;
  readonly tokens?: RunTokens;
  /** A COMPLETED run with at least one degraded node. */
  readonly degraded?: boolean;
  /**
   * The run's PUBLIC error — a fixed code and its fixed label. Absent on success, and when the
   * outcome came from a status read that carries no error.
   */
  readonly error?: { readonly code: string; readonly message: string };
  /** The result DESCRIPTOR the terminal event carried, when it carried one. Read the value with {@link RunHandle.result}. */
  readonly result?: RunResult;
}

/** Reconnect behaviour of a handle's streams. */
export interface RunHandleTuning {
  /**
   * Reconnects a stream may spend WITHOUT receiving a single frame before it gives up with
   * {@link RunStreamInterruptedError}. A connection that delivers anything resets the count.
   * Default `5`.
   */
  maxReconnects?: number;
  /** First reconnect delay in ms; doubles per consecutive failure, capped at 5 s. Default `250`; `0` reconnects immediately. */
  reconnectDelayMs?: number;
}

/** Options for {@link RunHandle.events}. */
export interface RunEventsOptions {
  /** Stops THIS iteration. Never cancels the run. */
  signal?: AbortSignal;
  /**
   * Resume after this `seq` — the {@link RunHandle.lastSeq} a previous process persisted. Omit to
   * replay the retained window from the beginning.
   */
  after?: number;
  /** Reconnect when the connection drops before the run ends. Default `true`. */
  autoResume?: boolean;
  /** Overrides the handle's reconnect budget for this iteration. */
  maxReconnects?: number;
}

/** Options for {@link RunHandle.text}. */
export interface RunTextOptions extends RunEventsOptions {
  /** Which text output to follow. Default `'text'`. */
  field?: string;
  /** Follow one node only. Default: every node that streams `field`. */
  nodeId?: string;
}

/** Options for {@link RunHandle.wait}. */
export interface RunWaitOptions extends RunEventsOptions {
  /**
   * Poll `GET …/runs/:runId` instead of streaming. Use it where a proxy buffers `text/event-stream`,
   * or when a stream is not worth holding open. Default `false`.
   */
  poll?: boolean;
  /** Delay between polls, in ms. Default `1000`. */
  intervalMs?: number;
}

/** Options for {@link RunHandle.result}. */
export type RunResultOptions = RunWaitOptions;

/** Options for {@link RunHandle.cancel}. */
export interface RunCancelOptions {
  signal?: AbortSignal;
}

/** What `cancel()` answers: the status the gateway reported (`cancel_requested` for a workflow — the signal is SENT, cancellation may not be complete). */
export interface RunCancelResult {
  readonly runId: string;
  readonly status: string;
}

/** Everything a resource gives a handle. */
export interface RunHandleInit extends RunHandleTuning {
  transport: Transport;
  kind: 'workflow' | 'agent';
  slug: string;
  runId: string;
  /** `true` when an `Idempotency-Key` collision joined a run already in flight instead of starting one. */
  joined?: boolean;
}

/** One SSE connection's lifetime budget; a stream that outlives it is simply re-opened (it counts as no failure). */
const STREAM_CONNECTION_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RECONNECTS = 5;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** `409 RUN_NOT_TERMINAL` on the result route is a race with a terminal write; this many short retries ride it out. */
const RESULT_NOT_TERMINAL_RETRIES = 5;
const RESULT_NOT_TERMINAL_DELAY_MS = 500;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Is this the kind of failure a reconnect can cure? A 4xx (not yours, bad protocol, bad cursor) is not. */
function isTransient(error: unknown): boolean {
  if (error instanceof APIConnectionError) return true;
  if (error instanceof HopeAPIError) return error.status >= 500 || error.status === 408 || error.status === 429;
  if (error instanceof TypeError) return true; // undici: "terminated", "fetch failed", reset sockets
  const name = error instanceof Error ? error.name : undefined;
  return name === 'TimeoutError';
}

function elapsedMs(startedAt: unknown, endedAt: unknown): number | undefined {
  if (typeof startedAt !== 'string' || typeof endedAt !== 'string') return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isNaN(start) || Number.isNaN(end) ? undefined : Math.max(0, end - start);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle === undefined) return null;
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

interface ResultRef {
  url: string;
  expiresAt?: string;
  sizeBytes?: number;
  sha256?: string;
}

export class RunHandle<TOutput = unknown> {
  readonly runId: string;
  readonly kind: 'workflow' | 'agent';
  readonly slug: string;
  /** `true` when the start joined a run already in flight (an `Idempotency-Key` collision). */
  readonly joined: boolean;

  private readonly transport: Transport;
  private readonly tuning: Required<RunHandleTuning>;
  private readonly base: string;
  private readonly eventsPath: string;

  private currentStatus: RunStatus = 'RUNNING';
  private currentOutcome: RunOutcome | undefined;
  private highestSeq = 0;
  private cancelRequest: Promise<RunCancelResult> | undefined;

  constructor(init: RunHandleInit) {
    this.transport = init.transport;
    this.kind = init.kind;
    this.slug = init.slug;
    this.runId = init.runId;
    this.joined = init.joined ?? false;
    this.tuning = {
      maxReconnects: init.maxReconnects ?? DEFAULT_MAX_RECONNECTS,
      reconnectDelayMs: init.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
    };
    const collection = init.kind === 'workflow' ? 'workflows' : 'agents';
    this.base = `${collection}/${encodePathSegment(init.slug)}/runs/${encodePathSegment(init.runId)}`;
    this.eventsPath = `${this.base}/${init.kind === 'workflow' ? 'stream' : 'events'}`;
  }

  /**
   * The run's status as last OBSERVED by any iterator, poll or cancel on this handle — `RUNNING`
   * until one of them sees it end. It is a local view, not a live read; {@link wait} makes it
   * current.
   */
  get status(): RunStatus {
    return this.currentStatus;
  }

  /**
   * The highest resume cursor any iterator on this handle has reached. Persist it and hand it to
   * `events({ after })` in another process to continue where this one stopped. `0` on a legacy
   * gateway, whose frames carry no `seq`.
   */
  get lastSeq(): number {
    return this.highestSeq;
  }

  /** The terminal outcome, once any iterator, poll or cancel has seen the run end. */
  get outcome(): RunOutcome | undefined {
    return this.currentOutcome;
  }

  // ----------------------------------------------------------------------------------------------
  // events / text
  // ----------------------------------------------------------------------------------------------

  /**
   * The run's protocol-v2 events, in order, ending after the terminal one.
   *
   * Keep-alive `ping`s are consumed here (they only advance the cursor). A `run.resync` IS
   * delivered: the server could not replay from your cursor, so replace whatever state you built
   * from earlier events with `event.data.snapshot` — {@link text} does this for you.
   *
   * Throws {@link RunStreamInterruptedError} when the stream cannot be re-established; the run is
   * unaffected. A 4xx (an unknown run, a malformed cursor) is thrown as the typed API error, unretried.
   */
  async *events(options: RunEventsOptions = {}): AsyncGenerator<RunEvent, void, void> {
    const { signal } = options;
    const normaliser = new RunFrameNormaliser(this.runId);
    const budget = options.autoResume === false ? 0 : (options.maxReconnects ?? this.tuning.maxReconnects);
    let cursor = options.after ?? 0;
    let lastEventId: string | undefined = options.after === undefined ? undefined : String(options.after);
    let failures = 0;
    let lastError: unknown;

    for (;;) {
      if (signal?.aborted) throw abortReason(signal);
      let progressed = false;
      try {
        const response = await this.transport.stream({
          path: this.eventsPath,
          headers: {
            Accept: 'text/event-stream',
            [RUN_PROTOCOL_HEADER]: String(RUN_PROTOCOL_VERSION),
            // Omitted on a first connect: an empty header would name a cursor the gateway cannot resolve.
            ...(lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId }),
          },
          signal,
          timeoutMs: STREAM_CONNECTION_TIMEOUT_MS,
        });
        if (response.body) {
          for await (const frame of parseSseStream(response.body, { signal })) {
            progressed = true;
            const normalised = normaliser.normalise(frame);
            if (normalised.statusHint !== undefined) this.observeStatusHint(normalised.statusHint);
            if (normalised.protocol === 'legacy' && frame.id !== undefined) lastEventId = frame.id;
            for (const event of normalised.events) {
              if (normalised.protocol === 2) {
                const step = advanceRunCursor(cursor, event);
                cursor = step.cursor;
                lastEventId = String(cursor);
                this.highestSeq = step.reset ? cursor : Math.max(this.highestSeq, cursor);
                if (!step.deliver) continue;
              }
              this.observe(event);
              yield event as RunEvent;
              if (isTerminalRunEventType(event.type) || (event.type === 'run.resync' && isTerminalRunStatusValue(event.data.snapshot.status))) return;
            }
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!isTransient(error)) throw error;
        lastError = error;
      }

      // The connection ended and the run did not: that is a drop, whether it closed cleanly or reset.
      failures = progressed ? 0 : failures + 1;
      if (failures > budget) throw new RunStreamInterruptedError({ runId: this.runId, lastSeq: cursor, cause: lastError });
      if (!progressed && this.tuning.reconnectDelayMs > 0) {
        await sleep(Math.min(this.tuning.reconnectDelayMs * 2 ** (failures - 1), MAX_RECONNECT_DELAY_MS), signal);
      }
    }
  }

  /**
   * The text of the run as it is written: the `text` of every `output.text.delta` for `field`
   * (default `'text'`), in order.
   *
   * Survives a drop and a `run.resync` without repeating itself: on a resync it yields only the
   * part of the snapshot's text it has not already yielded. Two limits worth knowing. A node that
   * RETRIES (`node.started` with `attempt > 1`) starts its text over, and text already yielded
   * cannot be recalled — {@link result} is the authoritative value. And only nodes wired to the
   * output (or flagged `stream`) send text at all.
   */
  async *text(options: RunTextOptions = {}): AsyncGenerator<string, void, void> {
    const field = options.field ?? 'text';
    const yielded = new Map<string, string>();

    for await (const event of this.events(options)) {
      if (event.type === 'output.text.delta') {
        if (event.data.field !== field) continue;
        if (options.nodeId !== undefined && event.nodeId !== options.nodeId) continue;
        const node = event.nodeId ?? '';
        yielded.set(node, (yielded.get(node) ?? '') + event.data.text);
        if (event.data.text.length > 0) yield event.data.text;
      } else if (event.type === 'node.started' && (event.data.attempt ?? 1) > 1 && event.nodeId !== undefined) {
        yielded.delete(event.nodeId);
      } else if (event.type === 'run.resync') {
        for (const [node, fields] of Object.entries(event.data.snapshot.outputs)) {
          if (options.nodeId !== undefined && node !== options.nodeId) continue;
          const full = fields[field];
          if (typeof full !== 'string') continue;
          const have = yielded.get(node) ?? '';
          if (full.length > have.length && full.startsWith(have)) yield full.slice(have.length);
          yielded.set(node, full);
        }
      }
    }
  }

  // ----------------------------------------------------------------------------------------------
  // wait / result / cancel
  // ----------------------------------------------------------------------------------------------

  /**
   * Resolve when the run has ended, with its {@link RunOutcome}. A run that FAILED or was
   * cancelled still RESOLVES here — read `outcome.status`; use {@link result} when you want a
   * failure to throw.
   *
   * Streams by default (resumable, no polling); `{ poll: true }` reads `GET …/runs/:runId` every
   * `intervalMs` instead. A stream that cannot be re-established falls back to polling rather than
   * failing: the run's state is still readable. An aborted `signal` rejects and leaves the run alone.
   */
  async wait(options: RunWaitOptions = {}): Promise<RunOutcome> {
    if (this.currentOutcome !== undefined) return this.currentOutcome;
    if (options.poll !== true) {
      try {
        for await (const event of this.events(options)) void event;
      } catch (error) {
        if (!(error instanceof RunStreamInterruptedError)) throw error;
      }
      if (this.currentOutcome !== undefined) return this.currentOutcome;
    }
    return this.pollUntilTerminal(options);
  }

  /**
   * The value the run delivered, once it has finished: waits (see {@link wait}), then reads
   * `GET …/runs/:runId/result`. A large result arrives as a short-lived signed URL; it is fetched
   * WITHOUT your credentials, checked against the declared `sha256`, and a URL that expired is
   * re-requested once.
   *
   * `null` when the run completed and delivered nothing (204). Throws {@link RunFailedError} when
   * it ended FAILED, TIMED_OUT or CANCELED, a 410 {@link HopeAPIError} when the result is past its
   * retention, and {@link RunResultIntegrityError} for bytes that do not match their hash.
   */
  async result(options: RunResultOptions = {}): Promise<TOutput | null> {
    const outcome = await this.wait(options);
    if (outcome.status !== 'COMPLETED') {
      throw new RunFailedError({ runId: this.runId, status: outcome.status, code: outcome.error?.code, message: outcome.error?.message });
    }
    const resultPath = `${this.base}/result`;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.transport.stream({ path: resultPath, headers: { Accept: 'application/json' }, signal: options.signal });
      } catch (error) {
        const notTerminalYet = error instanceof HopeAPIError && error.status === 409 && error.code === 'RUN_NOT_TERMINAL';
        if (!notTerminalYet || attempt >= RESULT_NOT_TERMINAL_RETRIES) throw error;
        await sleep(RESULT_NOT_TERMINAL_DELAY_MS, options.signal);
        continue;
      }
      if (response.status === 204) return null;

      const text = await response.text();
      const parsed = text.length === 0 ? null : (JSON.parse(text) as unknown);
      if (response.headers.get('x-hope-result-kind') !== 'ref') return parsed as TOutput | null;

      const fetched = await this.followResultRef(parsed as ResultRef, options.signal);
      if (fetched !== undefined) return fetched.value as TOutput | null;
      // The signed URL had expired: loop once for a fresh one (the route mints a new URL per request).
      if (attempt >= 1) throw new HopeAPIError({ status: 403, message: `The signed result URL of run ${this.runId} was refused twice.` });
    }
  }

  /**
   * Ask the run to stop. Idempotent: concurrent and repeated calls share ONE request, a run already
   * seen finished makes none, and a failed request can be retried. Returns once the signal is SENT —
   * `status` may be `cancel_requested`, with cancellation still in progress; {@link wait} for the end.
   */
  cancel(options: RunCancelOptions = {}): Promise<RunCancelResult> {
    if (this.currentOutcome !== undefined) return Promise.resolve({ runId: this.runId, status: this.currentOutcome.status });
    if (this.cancelRequest === undefined) {
      this.cancelRequest = this.transport
        .request<RunCancelResult>({ method: 'POST', path: `${this.base}/cancel`, signal: options.signal, hasIdempotencyKey: true })
        .then(
          (answer) => {
            if (isTerminalRunStatusValue(answer.status)) this.settle({ runId: this.runId, status: answer.status as RunStatus });
            return answer;
          },
          (error: unknown) => {
            this.cancelRequest = undefined;
            throw error;
          },
        );
    }
    return this.cancelRequest;
  }

  // ----------------------------------------------------------------------------------------------
  // internals
  // ----------------------------------------------------------------------------------------------

  private async pollUntilTerminal(options: RunWaitOptions): Promise<RunOutcome> {
    const interval = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    for (;;) {
      if (this.currentOutcome !== undefined) return this.currentOutcome;
      const body = await this.transport.request<Record<string, unknown>>({ path: this.base, signal: options.signal });
      const status = String(body.status ?? '');
      if (isTerminalRunStatusValue(status)) {
        const apiError = body.error;
        const error =
          typeof apiError === 'object' && apiError !== null && typeof (apiError as RunError).code === 'string'
            ? { code: (apiError as RunError).code, message: (apiError as RunError).message }
            : undefined;
        const durationMs = typeof body.durationMs === 'number' ? body.durationMs : elapsedMs(body.startedAt, body.endedAt);
        return this.settle({
          runId: this.runId,
          status: status as RunStatus,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(typeof body.degraded === 'boolean' && body.degraded ? { degraded: true } : {}),
          ...(error === undefined ? {} : { error }),
        });
      }
      await sleep(interval, options.signal);
    }
  }

  /** Fetch a signed result URL. `undefined` means "it was refused — ask the route for a fresh one". */
  private async followResultRef(ref: ResultRef, signal?: AbortSignal): Promise<{ value: unknown } | undefined> {
    const response = await this.transport.fetchExternal(ref.url, { signal });
    if (response.status === 403 || response.status === 410) return undefined;
    if (!response.ok)
      throw new HopeAPIError({
        status: response.status,
        message: `The signed result URL of run ${this.runId} could not be read (${response.status}).`,
      });
    const bytes = await response.arrayBuffer();
    if (ref.sha256 !== undefined) {
      const actual = await sha256Hex(bytes);
      if (actual !== null && actual !== ref.sha256.toLowerCase()) throw new RunResultIntegrityError(this.runId);
    }
    const text = new TextDecoder().decode(bytes);
    return { value: text.length === 0 ? null : (JSON.parse(text) as unknown) };
  }

  private observeStatusHint(status: string): void {
    if (this.currentOutcome === undefined && !isTerminalRunStatusValue(status)) this.currentStatus = 'RUNNING';
  }

  /** Fold one delivered event into the handle's view of the run. */
  private observe(event: RunEventV2): void {
    switch (event.type) {
      case 'run.completed': {
        const { durationMs, tokens, degraded, result } = event.data;
        this.settle({
          runId: this.runId,
          status: 'COMPLETED',
          durationMs,
          tokens,
          ...(degraded === true ? { degraded: true } : {}),
          ...(result === undefined ? {} : { result }),
        });
        break;
      }
      case 'run.failed': {
        const { status, durationMs, tokens, error } = event.data;
        this.settle({
          runId: this.runId,
          status,
          durationMs,
          ...(tokens === undefined ? {} : { tokens }),
          error: { code: error.code, message: error.message },
        });
        break;
      }
      case 'run.cancelled':
        this.settle({ runId: this.runId, status: 'CANCELED', durationMs: event.data.durationMs });
        break;
      case 'run.resync': {
        const { snapshot } = event.data;
        if (isTerminalRunStatusValue(snapshot.status)) {
          this.settle({ runId: this.runId, status: snapshot.status, ...(snapshot.result === undefined ? {} : { result: snapshot.result }) });
        }
        break;
      }
      default:
        break;
    }
  }

  /** Record the terminal outcome. The FIRST one wins: a later, thinner view of the same end never replaces it. */
  private settle(outcome: RunOutcome): RunOutcome {
    if (this.currentOutcome === undefined) {
      this.currentOutcome = outcome;
      this.currentStatus = outcome.status;
    }
    return this.currentOutcome;
  }
}
