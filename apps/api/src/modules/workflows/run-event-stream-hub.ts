import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { IConfigService, TenantSettingsService, WORKFLOW_RUNS_DEFAULTS, WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY } from '@arcaai/applications';
import {
  RUN_APPEND_LUA,
  RUN_DEDUPE_KEY,
  RUN_EVENTS_KEY,
  RUN_SEQ_KEY,
  RUN_STREAM_CLOSED_ERROR,
  TERMINAL_RUN_EVENT_TYPES,
  buildRunAppend,
} from '@arcaai/async-contract';
import type { RunAppendInput } from '@arcaai/async-contract';
import Redis from 'ioredis';
import { compareStreamIds } from './workflow-run-event';

/** One entry of a run's event stream: Redis' own id and the raw field list. */
export interface RunStreamEntry {
  id: string;
  fields: string[];
}

/** How a caller waits for the next entries of ONE run stream. */
export interface RunStreamReadOptions {
  /** Resolve with `[]` once this long has passed with nothing new. Never a poll interval. */
  timeoutMs: number;
  /** Abandon the wait (client gone) — resolves with `[]`. */
  signal?: AbortSignal;
}

/**
 * The subset of an ioredis connection the hub uses. Declared so a test can substitute a fake
 * that serialises commands the way a real socket does (`__tests__/fake-redis-streams.ts`).
 */
export interface RunStreamConnection {
  xread(...args: (string | number)[]): Promise<unknown>;
  xrange(key: string, start: string, end: string, countWord: 'COUNT', count: number): Promise<unknown>;
  /** TASK-1038 B3a — the resume helpers read backwards from the tail. */
  xrevrange(key: string, end: string, start: string, countWord: 'COUNT', count: number): Promise<unknown>;
  /** TASK-1038 B3a — `GET wf:run:<runId>:seq`. */
  get(key: string): Promise<string | null>;
  /** TASK-1038 B3a — the ONE sequencer, `RUN_APPEND_LUA`. */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  expire(key: string, seconds: number, mode: 'NX'): Promise<unknown>;
  client(subcommand: string, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

/** Entries pulled per key per `XREAD` — bounded so one chatty run cannot monopolise a batch. */
export const RUN_STREAM_HUB_READ_COUNT = 200;
/**
 * The longest ONE multiplexed `XREAD` parks. A new reader normally does not wait for it: the hub
 * releases the parked read with `CLIENT UNBLOCK` and re-issues it with the new key. This ceiling
 * only bounds the latency when that release cannot be delivered (e.g. the connection was
 * re-established mid-read and its client id changed).
 */
export const RUN_STREAM_HUB_BLOCK_MS = 5_000;
/** Backoff after a failed `XREAD`: doubles from the floor up to the cap, reset on success. */
export const RUN_STREAM_HUB_BACKOFF_FLOOR_MS = 100;
export const RUN_STREAM_HUB_BACKOFF_CAP_MS = 5_000;
/** Entries scanned per `XREVRANGE` page when a seq cursor is mapped to a stream id. */
export const RUN_STREAM_HUB_SCAN_PAGE = 200;
/** What a gateway-originated append answers: the script's `[seq, streamId, duplicate]`. */
export interface RunAppendResult {
  seq: number;
  streamId: string;
  duplicate: boolean;
}
/** `CLIENT UNBLOCK` can race the `XREAD` it targets onto the server; retry a few times. */
const WAKE_ATTEMPTS = 5;
const WAKE_RETRY_MS = 5;

interface PendingRead {
  key: string;
  cursor: string;
  /** The `XREAD` generation this read was part of, or `null` while it waits for the next one. */
  issuedIn: number | null;
  settle(entries: RunStreamEntry[]): void;
  fail(error: unknown): void;
}

/**
 * `RunEventStreamHub` — TASK-1038 R-1: ONE multiplexed reader for every run event stream this
 * process follows.
 *
 * **The defect it removes.** The SSE service, the background completion watcher and the WS
 * gateway each held ONE dedicated Redis connection and issued every blocking `XREAD BLOCK 15000`
 * on it. A connection answers one command at a time, so with N streams open the N-th read was
 * not even sent until the reads ahead of it had each parked for their whole window: head-of-line
 * blocking, latency growing with the number of concurrent runs.
 *
 * **The design, and why not a pool.** A pool of dedicated connections (one per parked read)
 * fixes the queueing only up to the pool's size — past it, readers queue for a connection and the
 * same head-of-line shape returns — and it costs one Redis client per open stream per replica.
 * The hub instead issues ONE `XREAD BLOCK … STREAMS k1 … kn id1 … idn` over every key a caller is
 * currently waiting on and demultiplexes the reply in process. Redis returns the moment ANY of
 * those streams has a new entry, so a busy run never delays a quiet one, and the process holds
 * exactly two connections however many streams are open: the blocking reader and a control
 * connection for everything non-blocking (`XRANGE`, `EXPIRE`, `CLIENT UNBLOCK`, a tail read).
 *
 * **Pull, not push — which is what makes backpressure free (R-9).** A caller asks for "the next
 * entries after my cursor" and gets them once; it asks again only when it has written them out.
 * A slow client therefore simply has no read outstanding, its key drops out of the next `XREAD`,
 * and its events wait in the stream (they are durable there) instead of in this process' memory.
 *
 * **New readers do not wait for the parked read.** Adding a key (or an earlier cursor) to an
 * `XREAD` that is already parked sends `CLIENT UNBLOCK` for the reader connection; the parked
 * read returns empty and is re-issued with the new key set at once. Requests in the same tick are
 * coalesced into one wake.
 *
 * **Failure.** A failed `XREAD` rejects exactly the reads that were part of it — each caller
 * decides what that means (the SSE route ends, the completion watcher retries) — and the hub
 * itself backs off exponentially before its next read, so a Redis outage is not a hot loop.
 */
@Injectable()
export class RunEventStreamHub implements OnModuleDestroy {
  private readonly logger = new Logger(RunEventStreamHub.name);
  /** Test seam: builds a connection. Production builds a dedicated ioredis client. */
  connectionFactory: (() => RunStreamConnection) | null = null;

  private reader: RunStreamConnection | null = null;
  private control: RunStreamConnection | null = null;
  private readerClientId: number | string | null = null;
  private readonly waiting = new Set<PendingRead>();
  /** key → cursor of the `XREAD` currently parked on the reader, or `null` when none is. */
  private inFlight: Map<string, string> | null = null;
  private generation = 0;
  private looping = false;
  private wakeScheduled = false;
  private backoffMs = 0;
  private closed = false;

  constructor(
    @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
    @Optional() private readonly settings?: TenantSettingsService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    for (const pending of [...this.waiting]) pending.settle([]);
    const connections = [this.reader, this.control].filter((c): c is RunStreamConnection => c !== null);
    this.reader = null;
    this.control = null;
    // swallow-ok: shutdown: a connection that cannot QUIT cleanly is being dropped anyway.
    await Promise.all(connections.map((connection) => connection.quit().catch(() => undefined)));
  }

  /** Whether a push transport exists at all. `false` ⇒ callers answer with a snapshot only. */
  available(): boolean {
    if (this.closed) return false;
    if (this.connectionFactory) return true;
    return this.configService?.isRedisConfigured() ?? false;
  }

  /** Outstanding reads — exposed for tests and diagnostics. */
  get pendingReads(): number {
    return this.waiting.size;
  }

  /**
   * Wait for the entries of `key` strictly after `cursor`. Resolves with them as soon as any
   * exist, with `[]` on `timeoutMs` or abort, and rejects when the read it was part of failed.
   */
  read(key: string, cursor: string, options: RunStreamReadOptions): Promise<RunStreamEntry[]> {
    if (!this.available()) return Promise.reject(new Error('run event stream transport is not configured'));
    if (options.signal?.aborted) return Promise.resolve([]);
    return new Promise<RunStreamEntry[]>((resolve, reject) => {
      const onAbort = (): void => pending.settle([]);
      const pending: PendingRead = {
        key,
        cursor,
        issuedIn: null,
        settle: (entries) => {
          if (finish()) resolve(entries);
        },
        fail: (error) => {
          if (finish()) reject(error);
        },
      };
      const timer = setTimeout(() => pending.settle([]), Math.max(0, options.timeoutMs));
      const finish = (): boolean => {
        if (!this.waiting.has(pending)) return false;
        this.waiting.delete(pending);
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        return true;
      };
      this.waiting.add(pending);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.kick(pending);
    });
  }

  /** A NON-blocking read of what is retained after `cursor` (the control connection). */
  async readNow(key: string, cursor: string): Promise<RunStreamEntry[]> {
    const result = await this.controlConnection().xread('COUNT', RUN_STREAM_HUB_READ_COUNT, 'STREAMS', key, cursor);
    return toEntries(result).get(key) ?? [];
  }

  /** The oldest RETAINED entry id of `key`, or `null` when nothing is retained. */
  async oldestEntryId(key: string): Promise<string | null> {
    const rows = (await this.controlConnection().xrange(key, '-', '+', 'COUNT', 1)) as [string, string[]][];
    return rows.length > 0 ? rows[0][0] : null;
  }

  /**
   * OD-25 — once a run is terminal its event stream expires `workflowRuns.eventRetentionHours`
   * later. `NX`: the FIRST observer of the terminal state sets the clock and every later one
   * (a reconnecting client, the watcher, a status read) leaves it alone, so watching a finished
   * run never extends its retention. Best-effort: a failure here costs retention, never delivery.
   *
   * TASK-1038 B3a (deliverable 5) — the backstop covers ALL THREE keys of the run (`seq`,
   * `events`, `dedupe`, protocol-v2.md §6.1), so a counter can never outlive its stream and hand
   * out a `seq` a second time, and the stream is CLOSED: a terminal event that arrives after the
   * backstop ran is refused by the sequencer and the read model serves the terminal state.
   */
  async expireAfterTerminal(runId: string): Promise<void> {
    if (!this.available()) return;
    const seconds = this.eventRetentionHours() * 3600;
    try {
      const control = this.controlConnection();
      await Promise.all([RUN_SEQ_KEY(runId), RUN_EVENTS_KEY(runId), RUN_DEDUPE_KEY(runId)].map((key) => control.expire(key, seconds, 'NX')));
    } catch (err) {
      this.logger.warn({
        message: 'run event stream TTL could not be set',
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * TASK-1038 B3a — append ONE gateway-originated run event through the sequencer
   * (`RUN_APPEND_LUA`, protocol-v2.md §6.1), on the CONTROL connection: the blocking reader is
   * never used for a write, and no producer `XADD`s or `INCR`s the run's keys directly.
   *
   * A terminal event carries `retentionSeconds`; when the caller omits it the hub resolves it from
   * `workflowRuns.eventRetentionHours` (never a literal). A non-conforming event throws
   * `RunProtocolError` — that is a programming error in the caller. Everything else is a
   * BEST-EFFORT MIRROR (§6.1): no transport, a Redis error or `RUN_STREAM_CLOSED` is logged and
   * answered `null`, and never fails the run that produced the event.
   */
  async append(input: RunAppendInput): Promise<RunAppendResult | null> {
    const terminal = (TERMINAL_RUN_EVENT_TYPES as readonly string[]).includes(input.type);
    const command = buildRunAppend(
      terminal && input.retentionSeconds === undefined ? { ...input, retentionSeconds: this.eventRetentionHours() * 3600 } : input,
    );
    if (!this.available()) return null;
    try {
      const reply = (await this.controlConnection().eval(RUN_APPEND_LUA, command.keys.length, ...command.keys, ...command.args)) as [
        number | string,
        string,
        number | string,
      ];
      return { seq: Number(reply[0]), streamId: String(reply[1]), duplicate: Number(reply[2]) === 1 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({
        message: message.includes(RUN_STREAM_CLOSED_ERROR)
          ? 'run event refused — the run stream is closed (terminal)'
          : 'run event could not be appended — the stream is a best-effort mirror',
        runId: input.runId,
        type: input.type,
        error: message,
      });
      return null;
    }
  }

  /** `GET wf:run:<runId>:seq` — the last `seq` assigned, or `null` when the run has none (yet, or any more). */
  async lastSeq(runId: string): Promise<number | null> {
    const raw = await this.controlConnection().get(RUN_SEQ_KEY(runId));
    if (raw === null || raw === undefined) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  /** The oldest RETAINED entry of `key`, or `null` when nothing is retained. */
  async oldestEntry(key: string): Promise<RunStreamEntry | null> {
    const rows = (await this.controlConnection().xrange(key, '-', '+', 'COUNT', 1)) as [string, string[]][] | null;
    return rows && rows.length > 0 ? { id: rows[0][0], fields: rows[0][1] } : null;
  }

  /** The newest entry of `key`, or `null` when nothing is retained. */
  async newestEntry(key: string): Promise<RunStreamEntry | null> {
    const rows = (await this.controlConnection().xrevrange(key, '+', '-', 'COUNT', 1)) as [string, string[]][] | null;
    return rows && rows.length > 0 ? { id: rows[0][0], fields: rows[0][1] } : null;
  }

  /**
   * The stream id of the entry whose stored `seq` is `seq`, scanning BACK from the tail in
   * `XREVRANGE` pages (resumes are near the tail; `MAXLEN` bounds the scan — protocol-v2.md
   * §6.2 step 3). `null` when no retained entry carries it.
   */
  async entryIdForSeq(key: string, seq: number): Promise<string | null> {
    const control = this.controlConnection();
    let end = '+';
    for (;;) {
      const rows = ((await control.xrevrange(key, end, '-', 'COUNT', RUN_STREAM_HUB_SCAN_PAGE)) as [string, string[]][] | null) ?? [];
      for (const [id, fields] of rows) {
        const stored = storedSeqOf(fields);
        if (stored === seq) return id;
        // Stored seqs are contiguous and only trimmed from the front: past it, it is not retained.
        if (stored !== null && stored < seq) return null;
      }
      if (rows.length < RUN_STREAM_HUB_SCAN_PAGE) return null;
      end = `(${rows[rows.length - 1][0]}`;
    }
  }

  private eventRetentionHours(): number {
    try {
      const value = this.settings?.resolvePlatform<number>(WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY).value;
      return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : WORKFLOW_RUNS_DEFAULTS.eventRetentionHours;
    } catch {
      return WORKFLOW_RUNS_DEFAULTS.eventRetentionHours;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The multiplexed read loop
  // ---------------------------------------------------------------------------------------------

  private kick(pending: PendingRead): void {
    if (!this.looping) {
      void this.loop();
      return;
    }
    const parked = this.inFlight;
    if (parked === null) return; // between reads: the next XREAD is built from `waiting` anyway
    const parkedCursor = parked.get(pending.key);
    if (parkedCursor === undefined || compareStreamIds(pending.cursor, parkedCursor) < 0) this.scheduleWake();
  }

  private async loop(): Promise<void> {
    this.looping = true;
    try {
      while (!this.closed && this.waiting.size > 0) {
        if (this.backoffMs > 0) await sleep(this.backoffMs);
        if (this.closed || this.waiting.size === 0) break;

        let reader: RunStreamConnection;
        try {
          reader = await this.readerConnection();
        } catch (err) {
          this.failAll(err);
          continue;
        }
        if (this.closed || this.waiting.size === 0) break;

        // Built AFTER the connection is ready and with no await before the XREAD is issued, so
        // every read registered up to this instant is in it and `inFlight` describes it exactly.
        const generation = ++this.generation;
        const cursors = new Map<string, string>();
        for (const pending of this.waiting) {
          pending.issuedIn = generation;
          const current = cursors.get(pending.key);
          if (current === undefined || compareStreamIds(pending.cursor, current) < 0) cursors.set(pending.key, pending.cursor);
        }
        const keys = [...cursors.keys()];
        const ids = keys.map((key) => cursors.get(key) as string);

        let result: unknown;
        try {
          this.inFlight = cursors;
          result = await reader.xread('COUNT', RUN_STREAM_HUB_READ_COUNT, 'BLOCK', RUN_STREAM_HUB_BLOCK_MS, 'STREAMS', ...keys, ...ids);
          this.backoffMs = 0;
        } catch (err) {
          this.inFlight = null;
          this.backOff(err, keys.length);
          for (const pending of [...this.waiting]) if (pending.issuedIn === generation) pending.fail(err);
          continue;
        }
        this.inFlight = null;

        if (result) this.dispatch(toEntries(result));
        // One macrotask so a caller that just received entries can ask for the next ones before
        // the next XREAD is built — otherwise every delivery would cost a wake round trip.
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      this.looping = false;
      this.inFlight = null;
    }
  }

  /** The reader could not even be obtained: every waiting read fails, then the hub backs off. */
  private failAll(err: unknown): void {
    this.backOff(err, this.waiting.size);
    for (const pending of [...this.waiting]) pending.fail(err);
  }

  private backOff(err: unknown, keys: number): void {
    // The connection may have been re-established: its client id is no longer known.
    this.readerClientId = null;
    this.backoffMs = Math.min(RUN_STREAM_HUB_BACKOFF_CAP_MS, Math.max(RUN_STREAM_HUB_BACKOFF_FLOOR_MS, this.backoffMs * 2));
    this.logger.warn({
      message: 'run event stream read failed — failing the reads it carried and backing off',
      keys,
      backoffMs: this.backoffMs,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  private dispatch(byKey: Map<string, RunStreamEntry[]>): void {
    for (const pending of [...this.waiting]) {
      const entries = byKey.get(pending.key);
      if (!entries) continue;
      const fresh = entries.filter((entry) => compareStreamIds(entry.id, pending.cursor) > 0);
      if (fresh.length > 0) pending.settle(fresh);
    }
  }

  /** Release the parked `XREAD` so it is re-issued with the current key set. Coalesced per tick. */
  private scheduleWake(): void {
    if (this.wakeScheduled) return;
    this.wakeScheduled = true;
    setImmediate(() => {
      this.wakeScheduled = false;
      void this.wake();
    });
  }

  private async wake(): Promise<void> {
    for (let attempt = 0; attempt < WAKE_ATTEMPTS; attempt++) {
      const parked = this.inFlight;
      if (parked === null || this.readerClientId === null) return;
      try {
        const released = await this.controlConnection().client('UNBLOCK', this.readerClientId);
        if (Number(released) === 1 || this.inFlight !== parked) return;
      } catch (err) {
        // No permission for CLIENT UNBLOCK, or the control connection is down: the parked read
        // still returns at its BLOCK ceiling, so this only costs latency.
        this.logger.debug({ message: 'run event stream wake failed', error: err instanceof Error ? err.message : String(err) });
        return;
      }
      // The XREAD may not have reached the server yet (two sockets, no ordering between them).
      await sleep(WAKE_RETRY_MS);
    }
  }

  private async readerConnection(): Promise<RunStreamConnection> {
    if (!this.reader) this.reader = this.createConnection('reader');
    if (this.readerClientId === null) this.readerClientId = (await this.reader.client('ID')) as number;
    return this.reader;
  }

  private controlConnection(): RunStreamConnection {
    if (!this.control) this.control = this.createConnection('control');
    return this.control;
  }

  private createConnection(role: 'reader' | 'control'): RunStreamConnection {
    if (this.connectionFactory) return this.connectionFactory();
    if (!this.configService?.isRedisConfigured()) throw new Error('run event stream transport is not configured');
    const config = this.configService.getRedisConfig();
    const connection = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      maxRetriesPerRequest: null,
      lazyConnect: false,
      connectionName: `hope-run-stream-hub-${role}`,
    });
    if (role === 'reader') {
      // A reconnect gives the reader a new client id; the next read re-learns it.
      connection.on('ready', () => {
        this.readerClientId = null;
      });
    }
    return connection as unknown as RunStreamConnection;
  }
}

/** The `seq` field of a stored entry, or `null` for a legacy (pre-v2) entry. */
export function storedSeqOf(fields: readonly string[]): number | null {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] !== 'seq') continue;
    const value = Number(fields[i + 1]);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  return null;
}

/** `XREAD`'s reply → key → entries. */
function toEntries(result: unknown): Map<string, RunStreamEntry[]> {
  const out = new Map<string, RunStreamEntry[]>();
  if (!Array.isArray(result)) return out;
  for (const [key, entries] of result as [string, [string, string[]][]][]) {
    out.set(
      key,
      entries.map(([id, fields]) => ({ id, fields })),
    );
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
